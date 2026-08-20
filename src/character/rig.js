/* ============================================================
   rig.js — Wally's proportions, skeleton and skin-capture volumes.

   This file is the numerical transcription of ART_DIRECTION §1.1. Every
   measurement below is written first in Wally-heights `H` (the unit the
   art direction uses) and then resolved to metres, so the table can be
   checked line by line against the document without doing arithmetic.

       H = 1.60 m       total standing height, crown to sole

   THREE THINGS LIVE HERE AND NOTHING ELSE
   ---------------------------------------
   1. PROP   — the measurement table. model.js sculpts from it, anim.js
              never touches it.
   2. BONES  — the skeleton: 33 bones, every one with an explicit WORLD
              bind position. Local offsets are derived, never authored,
              because a hand-authored local offset is a bug waiting for
              a proportion change.
   3. cap[]  — per-bone *capture volumes*. These are not render geometry;
              they are the simple capsules/spheres that decide which bone
              owns which piece of skin. Keeping them separate from the
              sculpt is what lets the sculpt be blobby and organic while
              the weights stay clean and predictable at the joints.

   BIND CONVENTION. Every bone's bind rotation is IDENTITY. That is a
   deliberate constraint: it means an animation pose is literally a set
   of euler angles, a blend is a lerp of those angles, and the spring
   solver's `bindQuat` capture is the identity it expects. Bone local
   positions carry all the structure.

   Wally faces +Z. This matches the controller's yaw convention
   (`Math.atan2(dx, dz)`), so yaw 0 = facing +Z = facing the camera in
   the default framing.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';

/** Total standing height, metres. The unit everything else is quoted in. */
export const H = 1.60;

/* ------------------------------------------------------------------
   PROP — ART_DIRECTION §1.1, resolved.
   The `H` column is the spec; the number is what we build.
   ------------------------------------------------------------------ */
export const PROP = {
  H,
  /* head — §1.1's "enormous, a third of him", and it has to be 1.15x the
     widest point of the torso.

     THE NUMBER TO CHECK IS THE RENDERED ONE, NOT THE AUTHORED ONE. The
     ears overlap the sides of the cranium, so the ball you can actually
     measure in a filled silhouette is the run between the two ear
     notches, not the sphere's diameter: 0.556 authored measures ~0.33 H.
     Against §1.1's 1.15x that caps the widest TORSO row at 0.287 H
     (0.459 m), which is where the belly's 0.464 comes from. It does NOT
     cap the arms: §1.1 puts the shoulders at 0.355 H, wider than the
     torso, and the arms are the limbs the slot is cut behind — see `arm`.
     Everything mounted on the face (glasses, tusks, trunk root, ear
     hinge) is scaled with the ball. */
  head:      { c: [0, 1.328, -0.004], r: 0.278 },        // 0.556 = 0.348 H
  /* torso — 0.40 H tall, PEAR, widest at 0.62 H from the ground.
     Profile is (y, halfWidth, zCentre, depthMul); depthMul is OPTIONAL
     and multiplies `torsoDepth` to give the half-DEPTH as a fraction of
     the half-width. It exists because the waist has to be narrow ACROSS —
     that is where the arm slot comes from — without becoming narrow FRONT
     TO BACK as well: a torso that pinches in both axes is a wasp waist,
     and in profile he read as a bent plank. Half-depth therefore runs
     0.184 at the belly to 0.127 at the waist while half-width runs 0.232
     to 0.109.

     THIS PROFILE IS NOW THE SURFACE, TO THE MILLIMETRE. It used to be a
     stack of overlapping ellipsoids that reported one thing and rendered
     another; model.js meshes it as a true lathe of this curve, so the
     numbers below are what you measure in the frame. Nothing here is a
     suggestion any more.

     THE PEAR IS A RATIO AND THE RATIO HAS TO BE BIG. The previous table
     ran 0.242 at the belly against 0.105 at the waist — 2.3x on paper —
     but the arm's outer edge sat at 0.230 for the whole of that drop, so
     the rendered outline fell only 5% and he was a parallel-sided tube.
     The arm is now outboard with real background behind it (see `arm`),
     so this profile is what you actually SEE: 0.232 at 0.62 H against
     0.109 at the waist, 2.13x, with the fall packed into the 140 mm
     between y 0.924 and y 0.786 so the eye gets a corner to hang the
     shape on rather than a long ramp.

     THE FRONT FACE PULLS BACK AS IT RISES, and that is what buys the
     trunk its air: zCentre runs +0.024 at the waist to -0.032 at the
     collar, so the chest wall retreats exactly where the trunk swings
     forward. The forward mass is carried by the belly ellipsoid instead.

     THE BOTTOM STATION IS A TAPER, NOT A CAP. A lathe ends in a
     hemisphere of the last station's radius: at 0.128 that would hang to
     y 0.388 and fill the crotch the legs are spread to open. Station 0
     tapers to 0.100 at y 0.452 so the cap is small and sits above the
     fork. */
  /* ROUND 2 — DE-GAUNTED against ref/wally-ref-cool.png. The critic's
     pixel comparison: "gaunt torso... fatten the belly into the pear
     profile". The reference has NO waist pinch at all — the pear tapers
     smoothly from the 0.62 H belly down into the fork and up into the
     chest. The old 0.109 waist at 0.648 (a 2.13x ratio) is what read as
     a starved tube with muscle-shadow bands hanging on it. The profile
     below never drops under 0.134 between the hips and the belly, and
     the bottom station is RAISED (0.452 -> 0.500) with a fuller hip row
     so the lathe's end cap sits up in the fork instead of dangling to
     y 0.352 between the legs — that dangling cap was the "visible
     crotch bulge" in crit-like-w.png. */
  /* ROUND 3 — THE PEAR IS LOW, per §1.1's own row ("belly is the widest
     point... at ~0.40 H above ground") and the critic's pixel comparison:
     "slim humanoid build with defined chest/waist shading, narrow hips".
     The old profile put its widest row at 0.62 H — chest-high, which is
     a torso wearing pecs — and pinched to 0.134 across the very band
     (0.55-0.79) where the reference is fattest. The profile below is a
     single smooth pear: widest 0.404 at y 0.70 (0.44 H), NO pinch
     anywhere, hips full, chest narrowing monotonically so the head
     overhangs a soft sloped shoulder. Measured off ref/wally-ref-cool.png
     the belly is ~0.26 H wide against a 0.35 H head ball — the head wins
     by 1.3x; nothing here may exceed 0.202. */
  /* ROUND 4 — THE HIPS TUCK, per §1.1 ("belly widest... hips tuck under.
     The reference pear is SMOOTH") and the welcome shot's own defects:
     the 0.168 hip row at 0.560 met thigh caps whose outer edge was 0.234
     and the join meshed as pointed jodhpur corners, while the bottom
     station's 0.128 end-cap hemisphere dangled to y 0.372 between the
     legs — the literal crotch bulge. The lower rows now taper
     MONOTONICALLY from the 0.202 belly into a 0.104 fork station whose
     cap bottoms out at y 0.436, above the thigh tops, and the legs (see
     `leg`) stay inside the pear line so no corner exists to mesh. */
  /* ROUND 5: the 0.104 cap at 0.540 still pinched off into a centred
     field drip between the thighs (welcome shot: a 40 mm teardrop at
     y 0.41-0.49). Smaller and higher — cap bottom 0.479, INSIDE the
     raised thigh caps — so the union has nothing left to drip. */
  /* ROUND 6 — THE PEAR SITS DOWN, AND THE NUMBER IS A PIXEL COUNT.
     ref/wally-ref-cool.png and shots/m-cool.png were both cut to a
     silhouette mask, scaled to a common figure height (ear tip to sole =
     1000 px = 1.591 m) and aligned on the leg axis; the per-row spans
     then compare directly. What they said:

       height above ground   ref half-width   round-5 half-width
         0.51 m (0.32 H)         0.198            ~0.196
         0.57 m                  0.208             0.179
         0.64 m (0.40 H)         0.217             0.166   <- the hole
         0.70 m                  0.214             0.205
         0.76 m                  0.204             0.207
         0.82 m                  ~0.190            0.194

     Two separate defects in one curve. The peak was at y 0.74 — the
     reference's is at 0.64, which is §1.1's own "widest at ~0.40 H above
     ground" — and between the hip row and the thigh tops the profile fell
     to 0.166 while the legs had not yet taken over, so the figure carried
     a WAIST 50 mm narrower than the reference has at that height. A pear
     with a waist in it is a torso, and that is what read as "tall and
     narrow" next to the render.

     The peak moves to y 0.665 and nothing between the fork and the belly
     ever drops under 0.190. The bottom station is fattened to 0.142 on
     purpose: its end cap now bottoms at y 0.433, which is the reference's
     own crotch line (f 0.72 = 0.445 m), and at 142 mm of radius it is a
     WIDE cap that overlaps both thigh cones from x 0.03 outward — not the
     narrow centred teardrop rounds 4 and 5 were killing. The drip they
     fixed was a 40 mm pinch-off hanging in clear air between two thin
     legs; the legs are 190 mm across now (see `leg`) and there is no
     clear air left for it to hang in. */
  /* ROUND 7 — THE PEAR HAS TO SURVIVE THE BACK VIEW, AND IT DID NOT.
     shots/sil-back-before.png, studio rig, CAMS.back: from behind he is a
     parallel-sided column. The reason is arithmetic, not taste. The arms
     hang outboard by design (see `arm`: outer edge 0.384, the hard-won
     fix for the stub fused into the flank), and above y ~0.95 their inner
     edge is INSIDE the flank — a fused shoulder, which is what an armpit
     is. So from behind the eye sees one block from armpit to hip: the
     chest wall at 0.168-0.149 and the belly at 0.215 differ by 1.44x,
     which at 300 px of figure is nine pixels of taper. A 1.44x pear is
     not a pear; it is a tube with a hint.

     THE FRONT SILHOUETTE DOES NOT SEE THESE ROWS AT ALL, which is what
     makes this free. Measured on the ruler's three-quarter frame, the
     left and right edges between f 0.49 and f 0.71 are BOTH set by the
     hands and forearms (outer 0.377-0.396), never by the torso wall
     (0.215) — so widening the belly by 13 mm a side and narrowing the
     chest by 12 changes no front row, and every back row.

     SO THE PEAR IS DEEPENED FROM THE TOP, NOT THE BOTTOM. The first cut
     did both — belly out 13 mm a side as well as chest in 12 — and the
     belly half of it had to come straight back out, because of an
     invariant this file already states and I checked too late. The arm
     hangs beside the flank with an authored slot of 43 mm at y 0.720,
     and both blends eat into it (the arm's join 0.016 pushes its surface
     out ~4 mm, the torso's 0.030 ~7.5), so 43 authored is ~32 real —
     barely the two mesher cells that keep arm and flank from welding.
     Widening the belly to 0.2190 at that station took the slot to 32
     authored, ~21 real, 1.5 cells: under the threshold, i.e. straight
     back into the welded flange the `hand` note fought. The four rows
     from the hips to y 0.800 are therefore exactly where they were.
     ONLY THE CHEST MOVES: 0.1490 -> 0.1370 at y 1.020, 0.1680 -> 0.1580
     at 0.940, and on up. Belly-to-chest goes 1.44x -> 1.57x, which is
     most of the pear the back view was missing, and it is bought in the
     one band where narrowing OPENS clearance instead of closing it. The
     armpit's inner edge at y 0.950 is 0.150 against a wall of 0.158 and
     at y 1.020 it is ~0.119 against 0.137, so the shoulder still reads
     fused at both stations — an armpit, not a hole.
     THE FORK STATION IS A CROTCH HEIGHT, NOT A HIP WIDTH, and that is
     what round 6 got 12 mm wrong. A lathe ends in a hemisphere of the
     last station's radius, so station 0 sets where the solid bridge
     between the thighs STOPS — which is the crotch you can see. At
     0.1520 on y 0.575 the cap bottomed at 0.423 and the ruler forked at
     f 0.735 against the reference's f 0.718; fattening it to 0.1580 for
     the thicker thighs pushed it to f 0.742, i.e. the wrong way. It is
     now 0.1320, bottoming at y 0.443 — the reference's own crotch line
     (f 0.718 = 0.445 m) to two millimetres.
     THE ROUND-4/5 DRIP CANNOT COME BACK AT THIS WIDTH, and the reason is
     the legs, not the cap. Their fear was a narrow cap pinching off into
     clear air between two thin dowels. The thighs now carry r 0.108 with
     inner edges at 0.026, and the cap's radius stays above 0.026 all the
     way down to y 0.451 — it overlaps both thigh cones for its entire
     length and never hangs free, so there is nothing for a teardrop to
     pinch off from. */
  torso: [
    [0.575, 0.1320,  0.020, 1.10],  // fork — cap bottoms ON the ref's crotch line
    [0.620, 0.2000,  0.026, 1.13],  // hips — full, barely tucked
    [0.665, 0.2150,  0.030, 1.16],  // <- WIDEST, 0.430 dia, 0.42 H up
    [0.730, 0.2080,  0.034, 1.17],
    [0.800, 0.1980,  0.028, 1.14],
    [0.870, 0.1800,  0.016, 1.08],
    [0.940, 0.1580,  0.002, 1.00],
    [1.020, 0.1370, -0.014, 0.94],
    [1.090, 0.1220, -0.024, 0.92],
    [1.162, 0.1020, -0.030, 0.94],  // narrow chest -> the head overhangs
  ],
  /* DEPTH IS 0.92 OF WIDTH, NOT 0.78. At 0.78 the belly measured 0.343
     front-to-back against 0.440 across, and in profile he was a plank:
     §1.1's pear has to read from the side as well as from the front, and
     a toy this chunky is very nearly as deep as it is wide. The belly
     ellipsoid then protrudes a further 25 mm past the torso wall, low and
     forward, which is the actual pot belly. */
  torsoDepth: 0.92,
  /* The belly has to be a REAL convexity, not a primitive that grazes the
     torso wall. At r.z 0.140 on zc 0.058 its front face landed at z 0.198
     against a torso front of 0.200 — two surfaces tangent over a 0.30 m
     patch. A cel terminator crossing a patch like that has nothing to hold
     on to: N.L sits within a few hundredths of the band threshold across
     the whole belly and the boundary wanders into a hard-edged amoeba with
     lit islands inside it. That is what read as shadow-map acne; there is
     no shadow map involved. Protruding 32 mm gives the terminator real
     curvature to glide over. */
  /* IT CARRIES DEPTH, NOT WIDTH. At r.x 0.206 the belly reached 0.189
     across at y 0.84 — wider than the torso wall there — so it, not the
     profile, was setting the flank through the whole band the arm has to
     hang beside, and it filled the slot in. r.x is now 0.176, under the
     torso at every height it exists at, while r.z 0.152 on zc 0.060 puts
     its front face 54 mm proud of the wall. That is the pot belly: a
     forward convexity, low and central, with real curvature for the cel
     terminator to glide over and nothing at all in the armpit. */
  /* ROUND 3: the pot rides LOW on the new pear — centred at 0.47 H, not
     at the sternum — and protrudes forward past the chest line exactly as
     §1.1's profile row asks. Front face z 0.078 + 0.156 = 0.234 against a
     torso front wall of ~0.232 at that height: a real convexity, low. */
  /* ROUND 4 — IT HAD STOPPED BEING A BELLY AT ALL. Checked against the
     profile it sits on: at y 0.752 the lathe's own front wall was
     z 0.243 (half-depth 0.213 on zc 0.030) and this ellipsoid's front
     face was z 0.234. It was nine millimetres INSIDE the torso — every
     millimetre of the pot belly was coming from the lathe, and all this
     blob contributed was a soft smin puff whose boundary is exactly the
     ring that shipped as the lower-belly stain (see the AO note in
     model.js). Lower (the pear's new peak is 0.665, not 0.74) and
     genuinely proud: front face 0.090 + 0.185 = 0.275 against a wall of
     0.252 at that height, so it stands 23 mm out and the cel terminator
     has real curvature to glide over. Still narrower in x than the
     profile at every height it exists at (0.190 against 0.211), so it
     cannot creep sideways into the slot the arm hangs in. */
  belly:     { c: [0, 0.690, 0.090], r: [0.190, 0.152, 0.185] },

  /* ears — span 0.78 H tip to tip, single ear 0.34 H tall x 0.22 H wide:
     a TALL leaf, not a disc. The inner edge sits just outside the cranium
     (head half-width 0.240) so the head ball still reads between them.
     The bone chain is exactly collinear so the spring solver's restDir is
     exact for all three segments.

     THE NUMBER THAT MATTERS IS THE ONE AFTER THE SOLVER. §1.1's silhouette
     test is measured on the rendered frame, and the ear chain carries
     gravity: authored at the spec 0.78 H the tips settle at 0.71 H and the
     test fails on a measurement. So the fan is authored 5% over
     (bind tip x 0.656 -> span 1.312 = 0.82 H) and secondary.js runs the
     ear chain at a fraction of the preset gravity, which lands the settled
     span on 0.78-0.79 H. Do not "correct" this table without re-measuring
     the render.

     The chain also sweeps UP and out rather than out and down. An ear that
     droops from the root reads as a spaniel; the reference sweeps up so the
     head ball is left exposed as a distinct dome above the ear line. */
  ear: {
    /* ROUND 2 — THE FAN RISES, IT DOES NOT HANG. The critic's pixel
       comparison: "ears hang down and outward like drooping plates; tips
       fall well below the jawline". The root is re-pinned HIGH on the
       skull (y 1.432 on a 1.606 crown) and the chain now climbs 0.35 per
       unit of reach instead of 0.10, so the fan's long axis points
       up-and-out and the settled tip sits at crown height (chain tip
       y 1.517 before lobes). The plane normal picks up a real upward
       tilt too — the fan leans BACK 20 degrees, per §1.1's "opens
       outward and backward at 25-35 degrees from vertical", showing its
       inner face to a front camera. */
    root: [0.285, 1.432, -0.052],
    dir:  [0.8720, 0.3510, -0.3410],
    seg:  0.1210,                        // x3 = 0.363 reach -> chain tip x 0.601
    plane: [0.220, 0.200, 0.955],        // ear-plate normal (left ear)
  },
  earSpan: 1.2560,                       // 0.78 H target AFTER the solver

  /* trunk — 0.42 H long, taper 1 : 0.45. It has to hang CLEAR of the
     chest, which is why it swings forward as it descends: the torso front
     face is at z ~ 0.20 and the trunk's back edge never gets nearer than
     40 mm to it. */
  /* 0.42 H OF ARC, MEASURED, NOT ESTIMATED. The previous table was
     0.513 m = 0.32 H — a tenth of a body-height short of §1.1 — and it
     finished at y 0.782, above the waist, which is why nothing about
     him read as an elephant below the chin. The stations below sum to
     0.677 m of arc = 0.423 H and finish at y 0.640, level with the
     waist and a third of the way down the thigh's reach.

     z RUNS OUT TO 0.386, NOT 0.376. The trunk has to hang CLEAR of the
     belly, and the belly ellipsoid's front face is at z 0.222. Station 2
     puts the tube's back edge at z 0.259 and station 3 at 0.299, so the
     void is 70-100 mm wide over the whole free length — which is what
     makes the trunk read as a separate limb in three quarter and in
     profile, and what keeps the mesher out of sliver territory. Above
     station 1 the tube is INSIDE the cranium and fuses with the face,
     which is the crease §1.5 asks for. The one thing that must never
     happen is a 30 mm void sustained over 150 mm of height: that is not
     a gap, it is a slot two cells wide, and it comes out as a hole.

     Taper is 0.1240 -> 0.0558, exactly 1 : 0.45 (§1.1). Five segments,
     because secondary.js runs it as §4's 5-bone chain: adding stations
     means adding bones, and the chain length is set by the table below,
     not by the station count. */
  /* MEASURED AGAIN, AND THE MEASUREMENT THAT MATTERED WAS THE WRONG ONE.
     The old table's void behind the trunk was 70-100 mm over the LOWER
     free length and nobody had checked the top of it: at y 1.02-1.06,
     where the trunk clears the jaw and the chest wall is at its most
     forward, the gap measured 30-48 mm. At the high tier's 15.5 mm cell
     that is two grid planes. Surface nets needs the field to be positive
     at a grid point to open a hole at all, and the relaxation pass then
     pulls whatever thread of surface it does emit straight back together
     — so the trunk came out welded to the sternum for its top 150 mm and
     the whole thing read as a raised welt down the front of the chest,
     an apron rather than a limb.
     Station 1 is 32 mm further forward and station 2 is 20 mm, and the
     chest wall behind it moved back with the new torso profile. The void
     is now 81 mm at y 1.09, 114 mm at 1.06 and 100-175 mm all the way to
     the tip: five to eleven cells, a hole the mesher cannot miss and one
     the AO bake fills with the dark separation §1.2 asks for.
     Above y 1.15 the tube is still inside the cranium and still fuses
     with the face, which is the crease §1.5 wants — it just starts 110 mm
     higher, right under the tusks, instead of halfway down the sternum. */
  /* FATTER DOWN ITS LENGTH, per the reference render: the ref trunk stays
     ~60% of root width at mid-hang, not 45% — the old taper thinned it
     into a cord that vanished against the chest in a front three-quarter.
     The back-edge void to the chest narrows by the added radius but stays
     70+ mm everywhere, still five cells at the high tier. */
  /* SHORTENED against the reference render: the ref trunk's up-curled tip
     finishes at NAVEL height (~0.52 H), not at the thigh — the 0.638 tip
     hung past the hands and read as the dominant mass of the whole body.
     Arc now ends at y 0.712 and the tip accents lift the visible nub to
     ~0.48-0.52 H, exactly the reference's hang. */
  /* ROUND 2 — SHORTER AND SLIMMER, per the critic's pixel comparison:
     "thick accordion trunk reaching down to hip height, blunt straight
     tip". Measured off ref/wally-ref-cool.png: the trunk's lowest point
     is ~0.51 H (y ~0.82) and the tip curls up-forward to ~0.56-0.60 H
     with the nostril showing. Root slimmed 0.123 -> 0.105 (the ref root
     is ~0.37 of the head width = 0.103 r), tip 0.045. The arc below ends
     at y 0.830; the 'cool'/idle tip accents (secondary.js) then lift the
     last two segments up-and-forward, which lands the visible nub at
     mid-chest exactly as the render hangs. */
  /* ROUND 3: station 0's z eased 0.196 -> 0.188 — its blend into the face
     was bulging the skin at lens height to z ~0.30, exactly where the
     glasses front has to sit; 8 mm buys the frame its seat without
     thinning the visible root. */
  /* ROUND 4 — SLIMMER AND STRAIGHTER, measured off ref/wally-ref-cool.png
     in pixels (head width 0.556 m as the yardstick): the ref trunk is
     ~0.145 m across at the tusk line and ~0.11 m at mid-hang; the old
     0.105 root rendered ~40% too thick and filled the whole gap between
     the tusks. Radii scaled to the ref; every station's BACK edge keeps
     its old z (the mesher voids to the chest and belly are unchanged),
     which pulls the front face in and the bind curve 9 degrees
     straighter at the root — so the welcome hang bends the skin less
     and the joint rings it was printing shrink with it.
     Bridge seat check: front face at the lens-bottom line (y 1.232) is
     z 0.310 against the old 0.315 — the glasses still rest ON the root. */
  /* ROUND 5 — LONGER, SLENDERER, ONE CONTINUOUS TAPER (trunk & tusk
     pass). Measured in pixels off ref/wally-ref-cool.png with the render
     calibrated on two independent landmarks: crown y 172 px, sole
     y 1445 px -> 796 px/m, which puts the ref's lens-bottom line at
     y 1.244 against our 1.232 and its trunk root at 1.262 against our
     1.262. On that scale the ref's trunk centreline runs ~474 px of
     PROJECTED arc from the root to the nostril — 0.60 m before the
     three-quarter foreshortening is undone, i.e. §1.1's 0.40 H. The
     round-4 table summed to 0.474 m = 0.296 H: a tenth of a body height
     short, which is why it stopped at chin height and the up-curled nub
     read as a lobe stuck on the end rather than the last third of a long
     spline.

     WHAT CHANGED AND WHY EACH NUMBER.
     - Arc 0.474 -> 0.607 m (0.379 H), +28%. The extra length is in the
       three LOWER segments, not the root: stations 0-1 keep the face
       join and the bridge seat exactly where the glasses pass left them.
     - Station 1's z eased 0.272 -> 0.285 so the tube's front face at the
       lens-bottom line (y 1.232) still lands at z 0.330 — the number the
       glasses' shellZ was seated against. The bridge does not move.
     - The taper is now MONOTONIC and finishes finer: 0.088 -> 0.0315
       (1 : 0.36, was 1 : 0.43). The old last two stations ran 0.042 ->
       0.038 — near-cylindrical, then capped by a 38 mm hemisphere, which
       is the definition of a club. Measured on the ref, the tube is
       ~0.074 m radius at the first incised line and ~0.038 at 80% down,
       so the fine finish is the reference's, not an invention.
     - The segments SHORTEN toward the tip (0.138 / 0.132 / 0.124 / 0.111
       / 0.102). The curl accents live in the last third; short segments
       there mean the same total arc is bought with a smaller angle at
       every joint, and the joint crease that made the nub look welded on
       disappears with it.
     Void to the chest: back edge to torso/belly front is 165 mm at
     y 1.03, 152 at 0.91, 109 at 0.80 and 109 at 0.70 — eight cells or
     more everywhere, wider than the round-4 table managed.

     THE LAST STATION IS A KNOB, AND THAT IS NOT THE OLD CLUB COMING
     BACK. Look at ref/wally-ref-cool.png at 5x on the nostril (the tip
     fills the frame): the reference trunk tapers to a genuinely slender
     tube and then FINISHES in a rounded bulb about two thirds the width
     of the upper trunk, with a soft crease where bulb meets tube. What
     read as a club in round 4 was a different thing entirely — the last
     two stations ran 0.042 -> 0.038, i.e. a cylinder, on a trunk that
     was a tenth of a body-height too short, hinged 87 degrees at one
     joint. Here the tube genuinely narrows to 0.0355 at 78% of the
     length and the bulb flares back to 0.0435 over the last 102 mm: a
     6 degree flare, invisible as a joint, unmistakable as a nub. */
  /* ROUND 6 — THE NUB STOPS BEING A BULB. Round 5's last two stations
     ran 0.0370 -> 0.0470: a 27% flare over 102 mm, i.e. a neck and then
     a ball. On a straight tube that reads as the reference's soft
     finish; under `cool`'s 72-degree bend at the trunk4 joint the inner
     side of that neck folds and the flare beyond it separates off as its
     own form — which is exactly the "tip lobe reads as a slightly
     separate bulb" the pixel comparison caught, in both poses.
     0.0425 -> 0.0455 is an 7% flare instead of 27%: still a nub (the
     silhouette still swells past the tube feeding it, and the nostril
     still has a face to sit on), no longer a waist for the bend to
     crease. Station 3 eases 0.0500 -> 0.0480 so the whole lower third is
     one monotone taper into that finish. */
  trunk: [
    [0, 1.262, 0.205, 0.0880],
    [0, 1.150, 0.285, 0.0740],
    [0, 1.030, 0.340, 0.0620],
    [0, 0.910, 0.370, 0.0434],
    [0, 0.800, 0.386, 0.0384],
    [0, 0.698, 0.394, 0.0414],           // the NUB — see note below
  ],
  /* THE GROOVES HAVE TO BE ON THE FREE TUBE. §1.5 puts three shallow
     grooves across the trunk's top third — but the top third of this
     trunk is inside the cranium, and a torus carved there does not cut a
     wrinkle, it cuts a trench THROUGH the join and separates the trunk
     from the face. They sit on the first three stations of the free
     length instead: still the upper trunk, still evenly spaced, and
     actually visible. */
  /* ROUND 2: pulled up onto the BRIDGE (§1.5 and the critic: "exactly
     three short incised lines on the bridge... near the bridge only").
     The old rings at 0.966 sat mid-hang and, with the deep bite, read as
     accordion wrinkles down the whole tube. */
  /* ROUND 3: raised toward the glasses (lens bottom now 1.232) so the
     three lines sit on the visible BRIDGE of the trunk, between the
     frame and the tusk line, per §1.5 and the critic's "bridge is bare". */
  /* ROUND 4: measured off the ref — the three dashes start ~55 px
     (0.066 m) under the lens bottom and sit ~0.038 m apart, all on the
     first free segment so they share one axis frame. model.js now carves
     them as SHORT capsules across the top ridge (~60% of trunk width),
     not full tori — the tori wrapped the whole tube and read as
     vacuum-hose rings in the welcome pose. */
  /* ROUND 5 — RE-MEASURED, NOT RE-ARGUED. On ref/wally-ref-cool.png the
     two lines that are unoccluded from that camera sit at y 568 and
     614 px; at 796 px/m over a ground line of 1445 that is y 1.102 and
     1.044, spaced 58 mm, the third continuing to ~0.986. The round-4
     row (1.166/1.128/1.090, spaced 38) sat 60 mm too high — up inside
     the head/trunk join swell, where the cut rounds away to a smudge and
     the compensating stroke rod had to be parked on the swell instead of
     the tube. Down here the trunk is a FREE tube: the cut bites clean,
     the arc has real curvature to follow, and nothing has to be faked. */
  trunkGrooveY: [1.104, 1.046, 0.988],   // three, on the upper free tube, §1.5

  /* tusks — 0.11 H, from behind and below the trunk root, out then up.
     Left and right differ by 3 degrees (§1.3). */
  /* tusks — out, then slightly UP: the tip has to finish above the mid
     point or they read as a walrus moustache rather than tusks (§1.1).

     TWO THINGS ARE LOAD-BEARING HERE.
     1. The tip radius. 13 mm was under the mesher/tessellation floor and
        the tip collapsed into a single-sided sheet — two scraps of curled
        cardboard rather than two solid tusks. 21 mm clears it with room.
     2. z. At z 0.140-0.288 the whole tusk sat inside the trunk's own
        shadow volume and never saw the key, so it rendered at luma 158
        against §1.3's 236 — the right albedo, no light on it. Pushed
        forward and outward they clear the trunk and read as the two bold
        white shapes that frame it in ref/wally-logo.png. */
  /* THEY HAVE TO RISE, AND THE RISE HAS TO BE MEASURABLE. The previous
     table ran base y 1.210 -> tip y 1.212: a net rise of 2 mm over a
     0.118 H tusk, i.e. dead flat, and with dx 0.158 against dy 0.002 the
     travel was almost entirely lateral. Rendered, that is a walrus
     moustache lying sideways across the cheeks — §1.1 and §1.3 both ask
     for "out then slightly up".

     Now: base y 1.230, mid y 1.196, tip y 1.256. The curve dips 34 mm
     off the base and then climbs 60 mm, finishing 26 mm ABOVE the base
     and level with the trunk root at y 1.258 — a hook that reads as a
     tusk from any angle. The tip also pulls IN (x 0.206, was 0.244) so
     the arc is out-then-up rather than out-then-out, and the last
     section still travels 42 mm outward while it rises 60 mm, which is
     what stops it curling back into a comma.

     The base sits 28 mm below the trunk root and 100 mm off its axis,
     inside the root's 124 mm radius, so both tusks emerge from BEHIND
     the trunk (§1.1) instead of floating beside its middle. Arc length
     0.201 m = 0.125 H, against §1.1's 0.11 H. */
  /* REVISED AGAINST ref/wally-ref-cool.png (§1.1 new row): the tusks
     point DOWN, FORWARD and slightly OUT — two small matched cream cones
     flanking the trunk at its root, emerging from under the cheek line.
     The previous table ran base y 1.230 -> tip y 1.250: it rose, and the
     rise plus the outward travel turned them into a sideways moustache
     with one of the pair buried behind the trunk in three-quarter. The
     reference is unambiguous: both tips finish BELOW their bases, in
     front of the trunk's flanks, visible from the front simultaneously.
     Travel: down 0.104, out 0.064, forward 0.082 — a hook that reads as
     a small tusk from every angle. Arc 0.147 m = 0.092 H (§1.1's 0.09). */
  /* ROUND 2 — LONGER DROP, MATCHED PAIR. The critic saw "mismatched
     cones... both read as upward-pointing horns": the visible free length
     was only the last 35 mm, so the exit contour on the cheek dominated
     and the pair read as nubs pointing wherever the cheek surface did.
     The tip now finishes 120 mm below the base and ~150 mm proud of the
     skull — an unambiguous down-forward hook beside the slimmer trunk,
     visible in full from the front on both sides. Asymmetry halved and
     the right-scale brought to 0.995 so the pair reads matched. */
  /* ROUND 3 — LOWER AND MATCHED. The critic: "tusks anchored too high on
     the cheeks — their tops reach the lens line — pointing straight down,
     visibly mismatched". Sockets dropped 34 mm (base 1.200 -> 1.166, well
     under the lens bottom at 1.232) and buried 5 mm INSIDE the cranium
     ball so the butt emerges from the cheek instead of floating beside
     it; travel down 0.146 / out 0.052 / forward 0.082 — the canonical
     down-forward-out hook. asym goes to 0 and the right-scale to 1.0:
     the pair is now geometrically identical mirrored, per the critic's
     "mirror one tusk mesh so they match". */
  /* ROUND 4 — STUBBIER, PLUMPER, MATCHED. Measured off the ref: the tusk
     is a short cream comma, plump through its middle (~0.07 m across at
     the widest), rounded tip, arc ~0.14 m = 0.088 H. The old table ran
     0.16 m with a thin mid (0.027) so the pair read as long curved
     bananas — and the fat trunk buried the viewer-left one in the cool
     three-quarter. Shorter arc, mid radius up 0.027 -> 0.031, tip pulled
     up 22 mm; with the slimmed trunk (root 0.088) both clear it fully. */
  /* ROUND 5 — SHORT PLUMP CONES, NOT TEARDROPS. The critic on round 4:
     "elongated, nearly straight teardrops... long banana slabs, larger
     relative to the head than the ref's cones". Arc cut 0.139 -> 0.096 m
     (-31%), base fattened 0.0375 -> 0.045 with a near-linear taper to the
     rounded 0.020 tip — a true cone, no plump mid. Travel base -> tip:
     down 0.074, forward 0.056, out 0.024 — pitched ~37 degrees forward
     of vertical and yawed ~20 degrees outward, the ref's down-forward-out
     read (the ref's viewer-right tusk clearly angles toward the lens). */
  /* ROUND 6 — RE-AIMED FOR THE STUDIO CAMERAS. Round 5's cone was right
     on paper (pitch 37, yaw 14) but the near tusk's axis pointed almost
     straight down the cool camera's ray (azimuth 23 vs the cam's 29
     degrees) and foreshortened into a blunt teardrop, while the far one
     sat so close to the trunk (23 mm) that only an edge-on sliver showed —
     the critic's "flat slab". Pitch eased 37 -> 31 (inside the asked
     25-35), sockets 6 mm wider so the far cone clears the trunk by
     ~30 mm, and the arc stretched 0.096 -> 0.100 so the foreshortened
     near cone still shows a taper. Yaw stays ~15 out. */
  /* ROUND 6b — MORE OUT-YAW AT THE TIP. In the ref's three-quarter the
     far tusk's pointed end BREAKS the trunk silhouette, angled down-left;
     at 15 degrees of yaw ours stayed hidden behind the trunk edge from
     the cool camera and read as a vertical sliver. Tip pushed 12 mm
     further out (yaw ~22): the far cone's free tip clears the trunk, the
     near cone shows more flank instead of foreshortening at the lens. */
  /* ROUND 7 — RE-AIMED AND RE-SOCKETED (trunk & tusk pass). Two separate
     defects, both read straight off shots/s-cool.png next to the ref.

     1. THE FAR TUSK WAS BURIED. Base |x| 0.112 with r 0.045 put its
        inner wall at |x| 0.067 — INSIDE the trunk's 0.078 root radius —
        so the cone did not emerge from the cheek at all, it emerged from
        the trunk, and from the studio three-quarter (camera 29 degrees
        on his left, `cool` swinging the trunk toward the far side) all
        that survived was a pale sliver clipping the trunk's edge.
        Sockets pushed out 26 mm: base |x| 0.138, inner wall 0.091,
        13 mm clear of the root and ~60 mm clear at the mid. Projected on
        the studio camera's screen-right axis the far cone now shows
        ~72% of its width past the trunk instead of a hairline.

     2. THE NEAR TUSK POINTED STRAIGHT DOWN. Its bind axis was
        (0.038, -0.080, 0.044) — 36 degrees off vertical on paper, but
        41 degrees of that is OUTWARD yaw, and outward projects almost
        straight down the studio camera's right vector. Screen angle,
        computed against the CAMS.studio basis: 8.2 degrees off plumb.
        The ref's near tusk leans ~25 degrees toward the trunk, because
        the ref's tusks point FORWARD far more than they point out —
        forward is what projects to screen-left for a camera on his left.
        Travel rebalanced to (0.028, -0.114, 0.094): the same 0.09 H of
        arc, but the forward component now dominates and the projected
        lean lands at ~16 degrees.

     THE CURVE IS OUTWARD AND IT IS IN THE TABLE, NOT IN THE SWEEP. Base
     -> mid gains 8 mm of x, mid -> tip gains 20: the x-rate rises down
     the cone, which is a gentle outward bow rather than a banana. Radii
     0.047 / 0.0345 / 0.0205 — the ref's widest is ~0.100 m across at the
     cheek exit, tapering to a rounded, not pointed, tip. */
  /* ROUND 7b — DROPPED 32 mm. At base y 1.184 the socket's own radius
     put the far tusk's visible crown at y 1.231, dead on the lens-bottom
     line — the exact "tops reach the lens line" the round-3 critic
     rejected, reintroduced by the widening. The reference's far tusk
     crowns at y ~1.15. Base z pulled back 14 mm with it so the butt stays
     11 mm inside the cheek at the new, narrower cranium section; the
     travel vector is untouched.
     ROUND 7c — AND 14 mm WIDER AGAIN, because dropping them re-buried
     the far one. The trunk's z GROWS as it descends (0.285 at y 1.150 to
     0.340 at 1.030) and +z projects to screen-LEFT for a camera on his
     left, so the tube sweeps left down the frame and a tusk lowered by
     32 mm meets it further across. Projected on the studio camera's
     right vector: at base |x| 0.138 the far cone was 54% eclipsed (the
     sliver); at 0.152 it is 38% eclipsed with the `cool` trunk swing
     included, i.e. nearly two thirds of it in clear air. Base z pulled
     back to 0.140 keeps the butt 8 mm inside the cheek at the wider
     socket. */
  tusk: {
    /* buried root — 62 mm back along the base->mid axis, where the body
       field measures -58 mm; the 47 mm base cap is entirely inside the
       skull, so the side view shows a tusk crossing the cheek instead of
       a cone hanging beside it. Probed with buildBodyField().d(), not
       estimated off the head sphere: the head blends with the torso and
       the trunk, and the real skin sits several millimetres outside the
       raw ball. */
    root: [0.1427, 1.1953, 0.0967],
    base: [0.152, 1.152, 0.140],
    mid:  [0.164, 1.096, 0.196],
    tip:  [0.184, 1.038, 0.244],
    r:    [0.0470, 0.0345, 0.0205],
    asym: 0,
  },

  /* glasses — §1.4. REBUILT (ROUND 4) AS ONE RIGID ASSEMBLY ON A SINGLE
     SHARED SURFACE. The previous three rounds built the brow bar, the two
     lenses and the bridge on THREE unrelated surfaces — a world-horizontal
     parabolic sweep for the bar, tilted planes for the lenses (whose top
     edges sat ~20 mm BEHIND the bar's back face) and a separately swept
     bridge — so from any camera above the eye line the frame read as a
     floating visor plate with two disconnected lens blobs and bare skin
     between them. Verified in shots/my-cool.png / my-welcome.png.

     Now there is ONE parametric "face shell": a gently curved surface,
     pitched back a few degrees and wrapped cylindrically around the head's
     vertical axis. The ENTIRE front — thick brow bar whose lower edge
     flows into two trapezoid lens frames joined by a short bridge over the
     trunk root — is a single closed 2D silhouette (one outer outline, two
     lens-opening holes) extruded along that shell into one solid. The
     black lens panels are inset INTO the openings on the same shell. It is
     geometrically impossible for bar, frames and bridge to separate. All
     coordinates below are (s, t) on the shell: s across the face, t up. */
  glass: {
    /* shell placement: front centre of the assembly in bind space.
       shellZ 0.330 stands the front ~15 mm proud of the trunk-root bulge
       (z ~0.315 at the lens-bottom line) so the bridge rests ON the trunk
       root rather than the trunk crossing in front of the frame. */
    shellY:  1.3100,
    shellZ:  0.3300,
    /* top of the front leans back 7.5 degrees (lens bottoms forward over
       the trunk — the wayfarer sit the reference carries). */
    pitch:   7.5 * Math.PI / 180,
    /* cylindrical face-wrap radius about the (tilted) vertical axis.
       0.55 m gives ~59 mm of rearward sweep at the bar ends — the gentle
       wrap of ref/wally-ref-cool.png, nowhere near the old 132-degree
       headband. */
    wrapR:   0.55,
    /* lens OPENINGS (the holes in the front; the black panels sit in
       them). Centre, half-width, half-height. Ref lens ~0.40 head width. */
    lensS:   0.1280,
    lensA:   0.1000,
    lensB:   0.0700,
    /* frame margin wrapped around each opening (sides and bottom) — the
       visible rim of the trapezoid lens frames. */
    rimM:    0.0140,
    /* brow bar: its TOP edge (t) and half-span. Bottom edge is the
       opening tops at +lensB, so the bar flows directly into the lens
       frames — one silhouette, no seam. ROUND 5: 0.116 put ~46 mm of
       black above the openings and shots/ck-cool.png read as a visor;
       ref/wally-ref-cool.png carries a slim lip, lenses dominant.
       0.100 trims the bar 35% to ~30 mm. */
    barTop:  0.1000,
    barEndS: 0.2560,
    /* the arch cut up between the lenses under the bridge; apex t.
       Everything between the openings above this is bridge material,
       resting on the trunk root. */
    notchT:  0.0040,
    /* slab thickness along the shell normal. */
    depth:   0.0200,
    /* lens panels: FLAT plates recessed behind the frame front — the
       inset shadow line carries the depth read. Any forward dome lets a
       true-profile camera see the painted glint tangentially as a white
       curl on the lens silhouette (caught in lk-side.png at bulge
       0.005-0.008), so the panels stay flat. */
    lensInset: 0.0130,
    lensBulge: 0.0,
  },

  /* arms — 0.30 H, thick tapering sausage, no elbow break.

     THE OUTER EDGE IS THE WHOLE SILHOUETTE, SO IT IS THE THING THAT IS
     AUTHORED. The previous table's comment claimed "every station below
     the deltoid is the same width or narrower" and the numbers said
     otherwise: x + r ran 0.278 / 0.290 / 0.298 / 0.300 / 0.292, peaking
     at y 0.752 = 0.47 H. That put the widest row of the whole figure at
     0.47 H instead of §1.1's 0.62 H, made the outline parallel-sided
     from the armpit to the wrist, and beat the 0.544 head ball so the
     cranium never read as the widest mass.

     Outer edge now peaks at 0.230 at y 0.992 — which IS 0.62 H — and
     falls monotonically to 0.209 at the wrist, always UNDER the belly's
     0.242, so the widest ROW in the render is the belly. Span 0.460 = 0.287 H against a
     head ball that measures ~0.33 H in the render, so the ball wins by
     §1.1's 1.15x; and the arm never exceeds the belly, so the widest ROW
     is the belly at 0.62 H rather than the wrist at 0.47 H.

     The inner edge is what buys the gap. Against the waist (0.105-0.130
     across y 0.62-0.78) it clears the flank by 6 mm at y 0.780 and 26 mm
     at y 0.688 and 34 mm at the palm, so background opens at the wrist
     and closes into a proper armpit above the elbow — an arm that is a
     limb at the bottom and a shoulder at the top.

     z rises -0.002 -> 0.048 down the arm: the hand finishes in FRONT of
     the thigh rather than fused into its outer face, which is what turned
     the hand/hip boundary into a hard weight seam that the 'cool' pose
     then tore open into a faceted fan. */
  /* THE PREVIOUS TABLE COULD NOT HAVE WORKED AND THE ARITHMETIC SAYS SO.
     It capped every station's OUTER edge under the belly's 0.230 — which
     is the right instinct for the silhouette — but it then had to keep
     the centre-line at x 0.14-0.17, and with a 0.088-0.037 radius that
     puts the INNER edge at 0.052-0.135 against a flank running
     0.105-0.216. The arm was inside the torso for four of its five
     stations. Measured on the field it cleared the flank by 16 mm at
     exactly one height and by nothing anywhere else, which is why it
     rendered as a ridge moulded into the side of him rather than a limb.

     AND §1.1 ALREADY SAID THE ARMS ARE OUTBOARD OF THE BELLY. "Ear span
     0.78 H, wider than the shoulders by 2.2x" puts the shoulders at
     0.355 H = 0.568 m across — 24% wider than the 0.287 H torso. Capping
     the arm under the belly, which is what the previous table did to
     protect the silhouette, was never the specification; it was the thing
     that made the slot impossible. The deltoid's outer edge is now 0.276
     (0.552 span, ear-to-shoulder ratio 2.26 against §1.1's 2.2) and the
     outer edge then FALLS to 0.250 at the wrist, so the outline narrows
     17% below the shoulder instead of running parallel.

     Against the new profile: fused at y 0.868 and above, which is a
     shoulder and an armpit and is meant to be; then 43 mm at y 0.786,
     58 mm at 0.716, 64 mm at the wrist, and wider still beside the hand.
     Background opens at y 0.865 — just under the belly's widest row — and
     runs 200 mm to the wrist on a 400 mm arm, three to five mesher cells
     the whole way. That is a hole the grid can resolve and the relaxation
     pass cannot pull shut. */
  /* Deltoid slimmed 0.106 -> 0.096 against the reference: the render's
     shoulders are soft and narrow — the arm melts out of the flank with
     no ball — and at 0.106 the figure read athletic-V instead of pear.
     Outer edge 0.164 + 0.096 = 0.260; the belly row still reads widest. */
  /* ROUND 4 — DAYLIGHT IS THE SPEC, MEASURED OFF THE RENDER. Round 3's
     "kisses the flank" table is what shipped as a stub fused into the
     torso: 0-10 mm of clearance is UNDER the mesher blend (join 0.016
     eats ~4 mm) and under one grid cell (13.4 mm), so the slot never
     existed in the field and the arm meshed as a ridge on the pear.
     ref/wally-ref-cool.png measured: arm-outer span ~0.40 H (x 0.32),
     arm diameter ~0.06 H (r ~0.048 at the elbow), and a CLEAR sliver of
     background between arm and flank for most of the hang — ~0.02 H
     (~30 mm), i.e. two-plus mesher cells, from just under the armpit to
     the wrist. The inner edge below is authored 27-30 mm off the flank
     (torso profile + belly ellipsoid checked station by station), the
     shoulder stays fused above y ~0.95 as an armpit should, and the
     gentle inward curve at the bottom (x falls 0.268 -> 0.252) is the
     render's own relaxed hang. Both arms are the same table, mirrored. */
  /* BODY PASS — THE WRIST STOPS TURNING BACK. Rounds 1-4 pulled the last
     station INBOARD and BACK (x 0.268 -> 0.252, z 0.034 -> 0.052) while
     the palm was authored 43 mm further forward still, so the forearm
     axis and the hand axis disagreed by 24 degrees. The mesher then had
     to bridge that break, and what it drew was the shipped defect: the
     arm's own 38 mm end-cap hemisphere poking out ABOVE and BEHIND a
     mitten hung off its front — one limb with two silhouettes, read on
     pixels as "the forearm continues past the hand".
     The last two stations now lead INTO the hand instead of away from
     it: the wrist keeps travelling out (0.272 -> 0.264, a 8 mm inward
     curl rather than 16) and forward (0.040 -> 0.062), and PROP.hand
     continues that same direction. Break at the wrist: 6.8 degrees, i.e.
     a wrist rather than a joint. Outer edge 0.302 at the wrist against
     0.316 at the forearm, so the arm still narrows below the elbow. */
  /* LIKENESS FINAL — THE ARM WAS 62 % OF THE REFERENCE'S THICKNESS AND
     THE MEASUREMENT IS NOT ARGUABLE. Both renders cut to a silhouette
     mask, scaled to a common figure height (1000 px = 1.591 m), aligned
     on the leg axis; the arm leaves the flank as its own run from f 0.50
     down, so its width is a direct read:

                        ref            round-5 build
       free hang       0.085 H         0.055 H     (0.135 m vs 0.088 m)
       at the mitten   0.106 H         0.058 H
       outer edge     +0.225 H        +0.195 H
       inner edge     +0.130 H        +0.135 H
       lowest point    f 0.735         f 0.705

     So: 45 mm too thin down the whole limb, a mitten barely wider than
     the forearm feeding it, and a hand stopping 35 mm short. The
     reference arm is a full soft sausage that hangs to the top of the
     thigh with real volume; what shipped was a tapered stick.

     THE INNER EDGE IS THE CONSTRAINT AND IT DOES NOT MOVE. The gap the
     reference actually carries between arm and flank is a SLIT, not a
     corridor — measured 3-8 mm on the render, f 0.60-0.64 — and ours
     already measured 10 mm. So all 45 mm of new thickness goes OUTBOARD:
     every station's centre moves out by very close to the radius it
     gains, the inner edge lands within 6 mm of where it was, and the
     outer edge grows by twice the radius. Outer edge 0.365 against a
     belly half-width of 0.211 is a ratio of 1.73 — the reference's own
     arm-to-belly ratio measured off the mask is 1.74 (0.225 / 0.129).

     The gentle inward curl at the bottom survives (x runs out to 0.302
     at the forearm and comes back to 0.298 at the wrist) and so does the
     forward set (z 0.020 -> 0.070), which is what keeps the mitten in
     FRONT of the thigh rather than fused into its outer face. */
  arm: [
    [0.196, 1.058, -0.002, 0.090],       // deltoid — soft, fused shoulder
    [0.228, 0.950,  0.010, 0.078],       // armpit — BURIED in the flank, see note
    [0.292, 0.840,  0.024, 0.071],       // upper — the slot opens here
    [0.318, 0.720,  0.046, 0.066],       // forearm — full soft sausage
    [0.314, 0.598,  0.074, 0.063],       // wrist — leads into the mitten
  ],
  /* ==================================================================
     THE HAND — ONE TEARDROP MITTEN, MIRRORED. (§1.1's hand row, resolved
     against ref/wally-ref-cool.png at 3x on BOTH hands, which agree.)

     WHAT THE REFERENCE ACTUALLY SHOWS, and it is not what the last four
     rounds built. There is no palm-plus-lobe assembly and no separate
     fist parked in front of the wrist: the forearm simply SWELLS into a
     smooth teardrop about 1.2x its own width, carries that width for
     two thirds of the hand, and rounds off. The only interruption is ONE
     thumb — a small rounded lobe on the INBOARD face, high on the hand,
     tip pointing down-and-forward, separated by a single crisp crease
     that hooks around its root. No digits, no scallops, no knuckles.

     SO THE HAND IS AUTHORED AS TWO MORE STATIONS ON THE ARM CHAIN, not
     as its own blob. model.js appends `knuckle` and `tip` to armBlob()'s
     cone chain, which shares endpoints and is tangent-continuous by
     construction: there is no separate end-cap hemisphere left at the
     wrist to poke out behind the mitten, and no join field to bridge the
     hand-thigh gap. The thumb stays a blob of its own precisely BECAUSE
     it needs the join — its 0.016 is the width of that one crease.

     MEASURED CLEARANCES (bind, both sides identical by mirror):
       knuckle surface to thigh surface   26.8 mm  (~2.0 cells @ high)
       thumb base   to thigh surface      32.6 mm
       thumb tip    to thigh surface      40.1 mm
     — every one of them over the two-cell floor the round-4 note fixed
     as the weld threshold, so the welcome membrane cannot come back.

     Hand bottom lands at y 0.459 = 0.286 H. Measured off the reference
     at 793 px/m the mitten's lowest point is 0.299 H; the 13 mm short
     falls inside the pose's own hang. Outer edge 0.318 against a
     forearm outer of 0.316: the mitten continues the arm's line rather
     than stepping off it. */
  hand: {
    /* wrist is arm[4]; these two continue the SAME direction, tilted a
       further 6.4 degrees forward — the reference's gentle forward set,
       not a break.

       ROUND 2 OF THIS PASS — THE CLEARANCE WAS 28 mm AUTHORED AND 16 mm
       REAL, AND THAT IS THE DIFFERENCE BETWEEN A HAND AND A NEEDLE. The
       first cut kept the round-4 note's 27 mm surface gap to the thigh
       and still shipped a hard-edged flange off the inboard side of each
       mitten in the welcome frame. Diagnosed by projecting every posed
       vertex and reading back the six that landed in the flange: bind
       (0.204-0.212, 0.535-0.560, 0.051-0.071) — the mitten's own
       inboard-rear face — carrying handL 0.52-0.66 with hips, spine and
       legL0 sharing the REST. Those bones are six hops from handL, so
       they cannot arrive by capture (MAXHOP is 2); they arrived because
       the mesher had welded mitten to thigh there and smoothWeights then
       diffused thigh weight across the weld. Posed, 40% of a vertex stays
       on the hip while 60% swings out with the arm — a stretched needle.
       The authored gap was never the number that mattered. Both blends
       eat into it: the arm blob's join 0.016 pushes its surface out by
       k/4 = 4 mm and the leg's 0.030 by 7.5 mm, so 28 authored is 16
       real, which is 1.2 mesher cells at the high tier and under the
       two-cell weld threshold the round-4 note itself fixed.
       The whole lower arm therefore moves 12 mm outboard and 6 mm
       forward with the hand riding on its axis: 44 mm authored, ~33 mm
       after both blends, 2.4 cells. Outer edge 0.331 against a belly
       half-width of 0.202 — a ratio of 1.64 against 1.59 measured on
       ref/wally-ref-cool.png, so this is the reference's own hand-set,
       not a licence taken to dodge a weld. */
    /* LIKENESS FINAL — the mitten grows with the arm feeding it. Ref
       mitten 0.106 H = 0.169 m across against a 0.135 m forearm: a swell
       of 1.25x, which on a 0.063 wrist is a 0.079 knuckle. It also has to
       reach further down — the reference mitten bottoms at f 0.735
       (0.265 H above ground = 0.422 m) and the round-5 hand stopped at
       0.460. tip y 0.472 with a 0.050 cap lands the bottom at 0.422. */
    knuckle: [0.3120, 0.5220, 0.0980, 0.0840],   // widest, two thirds up
    tip:     [0.3100, 0.4700, 0.1150, 0.0530],   // rounds off
    /* the thumb: inboard face, high, down-and-forward. Its own blob so
       the union carries a real crease (join 0.016 in model.js). */
    /* THE THUMB HAS TO CLEAR ITS OWN PALM BY MORE THAN IT IS THICK, or
       it meshes as a crescent and reads as a BLADE the moment the wrist
       supinates — which is exactly what the first cut shipped in the
       welcome frame: a flat hard-edged fin off the inboard side of each
       mitten. The maths is the whole of it. A capsule whose axis sits
       46 mm off the palm axis inside a palm of radius 55 mm protrudes a
       17 mm cap, and a 17 mm cap on a 26 mm capsule is a lens, not a
       lobe: seen along its own plane it has no width at all.
       Axis moved to 50 mm off (radius 30) so the protrusion is 25 mm at
       the root and 46 mm at the tip — a solid finger from every angle,
       still 30 mm clear of the thigh at its nearest point. */
    /* The thumb rides ON the mitten, so it is authored as an offset from
       `knuckle` scaled by the knuckle's own radius (0.079 / 0.057 =
       1.386). The protrusion, the crease width and the clearance to the
       thigh all stay the ratios the last pass verified; only the scale
       changes with the hand. */
    thumbA:  [0.2499, 0.5318, 0.1259, 0.0416],
    thumbB:  [0.2312, 0.4647, 0.1446, 0.0333],
  },
  /* Compatibility view of the mitten as one ball — the AO proxy set and
     the handL capture volume both want a centre and a radius, and both
     must move when the table above does. */
  palm:      { c: [0.3110, 0.4980, 0.1065], r: [0.0790, 0.0790, 0.0790] },

  /* legs — 0.32 H, wide-set, thickest at the thigh, flared foot.
     Set wide enough apart that the crotch is a real gap in silhouette,
     not a nick: "four stubs" has to read (§1.1). */
  /* THE GAP IS 2 x (x - r) AND IT HAS TO BE WORTH SEEING. At x 0.150
     against a 0.120 thigh the crotch was 0.060 m of air, the smooth
     union then took 17 mm of that, and above the knee the two legs read
     as one fused mass with a nick in it. The thigh is now 0.082 on the
     same 0.150 axis: 0.136 m of authored gap = 0.085 H, and background
     runs the full height of the legs. Outer edge 0.232 stays under the
     belly's 0.230 + blend so the stance never becomes the widest row. */
  /* ROUND 2 — STUBBY STRAIGHT CYLINDERS, per the critic: "long bandy
     bent legs... shorten and straighten into stubby cylinders". The
     columns fatten (thigh 0.082 -> 0.092, ankle 0.044 -> 0.050), the
     x-drift flattens to near zero, and the thigh rises into the fuller
     hip row so the leg reads as a short straight stub off the pear. */
  /* ROUND 3: the columns barely taper — the reference leg keeps ~80% of
     its thigh width at the ankle (soft-boot stubs, §1.1) and the old
     0.050 ankle on a fixed x 0.152 opened a 204 mm gap between the shins
     that read as bandy. Fatter ankle, x pulled in: gap ~0.10 m, chunky. */
  /* ROUND 4 — INSIDE THE PEAR LINE. The 0.140/0.094 thigh put the leg's
     outer edge at 0.234 — 32 mm OUTBOARD of the 0.202 belly, and 66 mm
     outboard of the hip row it emerges from: that step is what meshed as
     the pointed jodhpur hip corner in the welcome shot. Measured off
     ref/wally-ref-cool.png the legs' outer span is ~0.88x the belly's, so
     the outer edge is now 0.196, under the pear everywhere, and the
     column still keeps 77% of its thigh radius at the ankle (sturdy,
     slight taper). Crotch gap 0.080 m = 0.05 H — clear, not a nick. */
  /* ROUND 5 — CHUNKY, per the same mask comparison that moved the pear.
     At f 0.80 (y 0.318) the reference leg renders 0.122 H across with a
     0.032 H gap between the shins; the round-4 build rendered 0.084 H
     across with a 0.054 H gap. Two thin dowels set wide apart under a
     narrow pear is the whole of "tall and narrow"; the reference is two
     short fat columns almost touching under a fat one.
     Authored 0.186 m across (the smin against the other leg and the
     torso adds ~9 mm to the rendered width and eats ~25 mm of the
     rendered gap — both measured on the round-4 frame, not assumed), so
     the render lands on the reference's 0.195 m column and 0.051 m gap.
     Outer edge 0.223 against the pear's 0.211: the reference's legs are
     a hair wider than its belly too — measured 0.140 H against 0.136 H —
     so this is the render's proportion, not a stance that has escaped. */
  /* ROUND 6 — SHORTER AND THICKER, AND THE NUMBERS COME OFF THE RULER.
     tools/silhouette.mjs cuts this build and ref/wally-ref-cool.png to
     binary masks, height-matches them (top of silhouette to sole) and
     compares row by row. What it said about the bottom third:

       f (from top)   game W     ref W      delta
         0.73         0.316      0.322      -0.006
         0.79         0.266      0.277      -0.011
         0.85         0.265      0.281      -0.016
         0.91         0.308      0.327      -0.020
         0.95         0.301      0.340      -0.039   <- the feet
       crotch split   f 0.676    f 0.703    -0.027

     THE LEGS ARE NOT TOO LONG, AND THAT COST A ROUND TO LEARN. The first
     cut of this pass shortened them 44 mm on a crotch metric that
     scanned down for "the first row whose silhouette splits in two" —
     which finds the daylight between arm and flank, 0.15 H above the
     fork, and is therefore not a crotch measurement at all. Re-measured
     with a metric that floods the enclosed background the shins stand
     either side of (silhouette.mjs `crotch`), the shortened build forked
     at f 0.741 against the reference's f 0.718: 0.023 H too SQUAT. The
     stations are back within 6 mm of where they were. What survives from
     that cut is the WIDTH, which the row profile asked for independently
     and which re-measured true.

     THE SOLE DOES NOT MOVE AND THE ANKLE DOES NOT MOVE. Foot IK, the
     contact-shadow projector and the controller's ground clamp are all
     hung off them, and none of that is this pass's business.

     WIDTH IS ADDED OUTBOARD OF THE AXIS, NOT INBOARD, because the crotch
     gap is already at the reference's own 0.05 H and closing it would
     weld the columns above the knee (the round-1 defect). Each station's
     centre moves out by about half the radius it gains, so the outer
     edge grows ~10 mm a side (+0.012 H of row width, which is the delta
     above) while the inner edge moves in by only 4 mm: authored crotch
     gap 0.052 against the old 0.056. Outer edge 0.242 is still inside
     the ear span (0.66 H) by a wide margin, so the widest row in the
     silhouette stays where §1.1 puts it. */
  leg: [
    [0.134, 0.524, 0.008, 0.108],        // thigh — 6 mm lower, 6% fatter
    [0.138, 0.297, 0.002, 0.106],        // knee — barely tapers
    [0.150, 0.128, 0.000, 0.100],        // ankle — 93% of the thigh, splayed out
  ],
  /* foot — a rounded WEDGE, 0.09 H long, no sculpted toes (§1.1).
     THE WEDGE HAS TO BE WIDER THAN THE LEG, NOT LONGER THAN IT. The old
     foot was 0.164 across against a 0.156 ankle — 1.05x — so it
     projected forward and not sideways, and from a front camera both
     legs simply ended in bevelled cylinder ends. Half-width is now
     0.052 (+ 0.030 round = 0.164 across) against an ankle of 0.092:
     1.78x, which shows as a flare from every angle including head-on,
     and still leaves the stance narrower than the belly so the widest
     row in the silhouette is §1.1's 0.62 H and not his boots. */
  /* ROUNDED SOFT-BOOT STUB, NOT A CHAMFERED BLOCK (ref/wally-ref-cool.png).
     The old h [0.052,0.014,0.052] on r 0.030 was a slab with bevels: flat
     top, straight sides, box corners. The round radius now carries most of
     the section (r 0.042 on h 0.034/0.020/0.040) so every edge is a curve,
     the sole still sits flat on the box's bottom face, and the toe-roll
     ellipsoid in model.js gives the slight forward toe box. */
  /* ROUND 2: the round radius now carries even more of the section
     (r 0.050 on a 0.026/0.016/0.032 box) — every edge a curve, per the
     critic's "round off the feet"; the flat sole survives on the box's
     bottom face. */
  /* ROUND 3: grown 9% with the fatter ankle above it — a soft-boot stub
     has to stay wider than the leg it ends (0.166 across against a
     0.164 ankle) or the flare disappears. The SOLE does not move:
     c.y - h.y - r is -0.011 either way, so foot IK and the contact
     shadow are untouched. */
  /* ROUND 4 — BROADER BOOT, SAME SOLE. The ruler's bottom rows (f 0.91 ->
     0.97) measured 0.020 / 0.029 / 0.039 H narrower than the reference —
     the biggest sustained deficit anywhere below the chest, and it is the
     boot flare, not the shin. c.y, h.y and r are untouched on purpose:
     c.y - h.y - r = -0.011 is the sole plane that foot IK, the contact
     shadow and the controller's ground clamp are all hung off, and this
     pass has no business moving it. Only the section grows — half-width
     0.042 -> 0.060 and half-depth 0.040 -> 0.048.

     AND THE STANCE SPLAYS, BECAUSE THE BOOT WAS ALREADY OVER-LONG. The
     first cut chased the whole 0.030 H deficit with boot section alone
     and the arithmetic said no: at h 0.042 on r 0.060 the boot already
     measured 0.200 m front to back = 0.125 H against §1.1's 0.10 H, so
     growing it further would have fixed a ruler row by breaking a spec
     row. The deficit is a STANCE width, not a shoe size. The leg's ankle
     station moves out 0.142 -> 0.150 and the boot rides with it, which
     puts the outer edge at 0.272 (0.544 m across the pair = 0.336 H
     against the reference's 0.340) while the boot's own length stays
     inside §1.1. The thigh does not move, so the columns run very
     slightly A-framed — feet set a little wider than hips — which is the
     reference's own stance. */
  foot: { c: [0.152, 0.069, 0.056], h: [0.060, 0.020, 0.048], r: 0.060 },
  /* the slight flare where the foot meets the leg (§1.1) */
  ankle: { c: [0.154, 0.116, 0.026], r: [0.076, 0.052, 0.078] },

  /* tail — §1.1 (new row): REQUIRED, it is in every reference. A thin
     rope from the low-center back, hanging to ~knee height (knee y 0.278,
     tuft bottom ~0.28), ending in a 0.03 H teardrop tuft. The previous
     table was an 0.088 m stub ending at y 0.576 — invisible from every
     camera, which is why "no tail" was a defect. Four stations = three
     bones, so it can sway as a rope rather than swing as a stick. */
  /* rope radius floor: 0.0125 ~= one mesher cell at the ultra tier —
     thinner and the rope pinches to a thread mid-length */
  /* ROUND 2: the rope pulled 20 mm further BACK. At z -0.148..-0.160 it
     hung in the middle of the leg gap and, seen from a straight front
     camera, read as a dangling crotch bulge (the critic flagged exactly
     that in the welcome shot). Deeper z keeps it against the rump: still
     canon from side/back, no longer front-and-centre through the gap. */
  /* ROUND 3: SHORTER AND TUCKED BEHIND, per the critic: the tuft was
     visible hanging between the legs in the straight-on welcome frame
     and "read awkwardly anatomical". The rope now stops just above the
     knee line (tuft bottom ~0.36) and its lower half angles BACK, away
     from the leg gap, so it stays inside the rump's silhouette from the
     front while remaining fully visible from side and back. */
  /* ROUND 4: THE ROPE DRAPES A TOUCH TO HIS LEFT. Dead-centre it hung
     exactly in the leg-gap corridor and the straight-on welcome camera
     saw the neck-and-teardrop through the crotch — the "bulge" defect,
     twice. The root stays low-centre (back view: rope emerges dead
     centre), but the lower stations drift +x so the tuft (x 0.052-0.100)
     tucks behind the left leg (inner edge 0.048) from the front, which
     is also §1.1's "occasionally peeks past a hip from the front
     three-quarter". _convergeChains holds bones ~within 3 degrees of
     bind at rest, so the authored drape survives the spring solver. */
  tail: [
    [0.000, 0.640, -0.138, 0.0165],
    [0.020, 0.536, -0.178, 0.0145],
    [0.052, 0.442, -0.196, 0.0130],
    [0.076, 0.372, -0.196, 0.0120],
  ],
};

/* ------------------------------------------------------------------
   BONES

   `w`   world bind position (metres). Local offsets are derived.
   `cap` capture volumes that claim skin for this bone:
           ['s', x,y,z, r]                     sphere
           ['c', ax,ay,az, bx,by,bz, ra, rb]   round cone (capsule)
           ['b', cx,cy,cz, hx,hy,hz, r]        round box
   `bias` added to this bone's capture distance — a thumb on the scale
          when two volumes unavoidably overlap.
   Left-side bones are authored once and mirrored; see `mirror()`.
   ------------------------------------------------------------------ */
const T = PROP.trunk;
const A = PROP.arm;
const L = PROP.leg;
const E = PROP.ear;
const TL = PROP.tail;

const earPt = (i) => [
  E.root[0] + E.dir[0] * E.seg * i,
  E.root[1] + E.dir[1] * E.seg * i,
  E.root[2] + E.dir[2] * E.seg * i,
];

const BASE_BONES = [
  { name: 'root',  parent: null,    w: [0, 0.000, 0] },
  /* LIKENESS PASS 4 — THE TORSO'S CAPTURE MUST REACH THE PEAR'S FLANK.
     The pear is ~0.21 wide over y 0.55-0.75 but the spine capsule was
     r 0.118/0.140 and hips r 0.118 at y 0.492: measured with
     wallyBoneAt, lower-flank TORSO skin at (0.19, 0.66, 0.05) came out
     0.58 handL — the hand cone was simply NEARER. Hand-to-torso is over
     MAXHOP, so that skin went to the arm chain outright, and every
     abducted welcome frame dragged the pear's own flank out with the
     mitten. The spine capsule is now fat enough to win the mid flank and
     the hips get a side sphere pair for the hip corner; the arm keeps
     its own skin because its capsules hug it at dv ~ 0. */
  /* ROUND 5 of the same argument: the pear widened to 0.211 and the hip
       row to 0.190, so both torso volumes grow with it — a capture that
       does not track the profile hands the flank straight back to the
       elbow the next time the arm abducts. */
  { name: 'hips',  parent: 'root',  w: [0, 0.500, 0.010],
    cap: [['c', -0.09, 0.492, 0.010, 0.09, 0.492, 0.010, 0.130, 0.130],
          ['s', -0.104, 0.560, 0.018, 0.118], ['s', 0.104, 0.560, 0.018, 0.118]] },
  /* BODY PASS — THE FLANK IS TORSO SKIN AND IT HAS TO BE WON BY THE
     TORSO. Measured on the shipped mesh: 147 vertices whose bind x runs
     out to 0.193 over y 0.674-0.900 — i.e. the pear's own outer wall,
     since the profile is 0.191 wide at y 0.674 — resolved to armL1 as
     their DOMINANT bone. bakeWeights then makes arm-won skin PURE arm
     (no torso share, by design, so the slot opens clean), so those
     vertices had no gradient at all: every degree of shoulder or elbow
     abduction translated them bodily outward and the welcome silhouette
     grew the pointed hip corners the critic flagged. It is a distance
     race and the old capsule was losing it by 10 mm — r 0.153 against a
     flank sitting 0.196 from the axis is 43 mm of gap, while the elbow
     cone passes within 33 mm of the same skin.
     r 0.186/0.190 closes that: the flank now resolves to spine by ~15 mm
     and the arm keeps every millimetre of its own, because its capsules
     hug it at dv ~ 0.002 and nothing widened here can approach that.
     Checked against the neighbours it could have stolen from — thigh
     top (leg wins by 11 mm), hip corner (hips spheres win), trunk (its
     own capture plus a 30 mm bias wins by 200 mm). Bottom station
     dropped 0.600 -> 0.585 so the hip band is covered continuously. */
  { name: 'spine', parent: 'hips',  w: [0, 0.700, 0.022],
    cap: [['c', 0, 0.575, 0.018, 0, 0.800, 0.034, 0.198, 0.200]] },
  { name: 'chest', parent: 'spine', w: [0, 0.965, 0.020],
    /* The second volume is a shoulder ball. Without it the arm capsule
       wins the whole shoulder fillet, and an arm that opens 45 degrees
       drags the flank out into a bat wing. */
    cap: [['c', 0, 0.880, 0.040, 0, 1.148, 0.008, 0.176, 0.128],
          ['s', 0, 1.020, 0.024, 0.198]] },
  /* Soft-body belly. Weighted by a dedicated rule in model.js, not by
     capture competition — a capture volume big enough to own the belly
     would also swallow the trunk that hangs in front of it. */
  { name: 'belly', parent: 'spine', w: [0, 0.706, 0.100], cap: null },
  { name: 'head',  parent: 'chest', w: [0, 1.180, -0.004],
    cap: [['s', 0, 1.342, -0.004, 0.254]] },
  /* Carries the glasses. No skin of its own. */
  { name: 'brow',  parent: 'head',  w: [0, 1.420, 0.160], cap: null },
  /* Under the trunk root. Owns the thin sliver of face beneath it so a
     talk clip can move something. */
  { name: 'jaw',   parent: 'head',  w: [0, 1.206, 0.118],
    cap: [['c', -0.056, 1.164, 0.150, 0.056, 1.164, 0.150, 0.034, 0.034]],
    bias: 0.008 },

  /* ---- trunk: 5 bones, §4 ----
     The captures are deliberately narrower than the sculpt and carry a
     30 mm bias. The trunk root fuses into the face and the trunk's lower
     half hangs a few centimetres in front of the chest, so a capture
     matching the trunk's real radius wins over the head and the chest in
     both places — and then a curl clip drags the face and the sternum
     with it. The bias is what keeps the curl inside the trunk. */
  { name: 'trunk0', parent: 'head',   w: [T[0][0], T[0][1], T[0][2]], bias: 0.030,
    cap: [['c', T[0][0], T[0][1], T[0][2], T[1][0], T[1][1], T[1][2], T[0][3] * 0.72, T[1][3] * 0.75]] },
  { name: 'trunk1', parent: 'trunk0', w: [T[1][0], T[1][1], T[1][2]], bias: 0.030,
    cap: [['c', T[1][0], T[1][1], T[1][2], T[2][0], T[2][1], T[2][2], T[1][3] * 0.75, T[2][3] * 0.75]] },
  { name: 'trunk2', parent: 'trunk1', w: [T[2][0], T[2][1], T[2][2]], bias: 0.030,
    cap: [['c', T[2][0], T[2][1], T[2][2], T[3][0], T[3][1], T[3][2], T[2][3] * 0.75, T[3][3] * 0.75]] },
  { name: 'trunk3', parent: 'trunk2', w: [T[3][0], T[3][1], T[3][2]], bias: 0.030,
    cap: [['c', T[3][0], T[3][1], T[3][2], T[4][0], T[4][1], T[4][2], T[3][3] * 0.75, T[4][3] * 0.75]] },
  { name: 'trunk4', parent: 'trunk3', w: [T[4][0], T[4][1], T[4][2]], bias: 0.030,
    cap: [['c', T[4][0], T[4][1], T[4][2], T[5][0], T[5][1], T[5][2], T[4][3] * 0.8, T[5][3] * 1.25]] },

  /* ---- tail: 3 bones over 4 stations, so the rope can sway. The
     captures carry a +12 mm margin because the rope is only ~10 mm thick
     and the mesh skin sits a blend radius outside the primitives; the
     last capture reaches past the tuft so it rides with the tip. ---- */
  { name: 'tail0', parent: 'hips',  w: TL[0].slice(0, 3),
    cap: [['c', TL[0][0], TL[0][1], TL[0][2], TL[1][0], TL[1][1], TL[1][2], TL[0][3] + 0.012, TL[1][3] + 0.012]] },
  { name: 'tail1', parent: 'tail0', w: TL[1].slice(0, 3),
    cap: [['c', TL[1][0], TL[1][1], TL[1][2], TL[2][0], TL[2][1], TL[2][2], TL[1][3] + 0.012, TL[2][3] + 0.012]] },
  { name: 'tail2', parent: 'tail1', w: TL[2].slice(0, 3),
    cap: [['c', TL[2][0], TL[2][1], TL[2][2], TL[3][0], TL[3][1] - 0.030, TL[3][2], TL[2][3] + 0.012, TL[3][3] + 0.034]] },
];

/* Left-side chains, mirrored to the right by negating x. */
const LEFT_BONES = [
  /* ears — the capture volume is a VERTICAL slab at that bone's x, not a
     sphere: the fan is 0.54 m tall and 0.15 m of chain has to own all of
     it or the ear folds like a taco instead of bending like an ear. */
  /* THE SLAB HAS TO STOP ABOVE THE SHOULDER. It used to hang to y 1.020,
     which was harmlessly below the ear (lowest lobe 1.126) and harmlessly
     outboard of a deltoid whose outer edge was 0.230. The deltoid is now
     at 0.276 (§1.1's shoulder), so at y 1.05 the ear's capture — a slab at
     x 0.292 +/- 0.060, i.e. 0.232 to 0.352 — was winning the shoulder
     outright: measured, the skin at (0.27, 1.05, 0) came out 0.74 earL0,
     which means the shoulder flaps when the ear does. 1.190 / 1.150 / 1.120 track the fan's own lower
     edge (1.276 at the root, 1.126 at the tip) and clear the deltoid,
     whose skin tops out at 1.162. */
  /* ROUND 2: the fan now spans y 1.16-1.66 (it RISES — see PROP.ear), so
     the slabs track it: tops at 1.70 over the new 1.66 top edge, bottoms
     raised clear of the deltoid (skin tops out ~1.16). */
  { name: 'earL0', parent: 'head',  w: earPt(0),
    cap: [['c', earPt(0)[0], 1.700, earPt(0)[2], earPt(0)[0], 1.240, earPt(0)[2] + 0.02, 0.060, 0.060]] },
  { name: 'earL1', parent: 'earL0', w: earPt(1),
    cap: [['c', earPt(1)[0], 1.700, earPt(1)[2], earPt(1)[0], 1.190, earPt(1)[2] + 0.02, 0.064, 0.064]] },
  { name: 'earL2', parent: 'earL1', w: earPt(2),
    cap: [['c', earPt(2)[0], 1.690, earPt(2)[2], earPt(2)[0], 1.140, earPt(2)[2] + 0.02, 0.098, 0.098]] },

  /* arms — 3 bones over 5 sculpt stations: shoulder at A0, elbow at A2,
     wrist at A4. The hand capture reaches past the palm so the digits
     ride with it instead of being fought over by the elbow. */
  /* THE DELTOID CAPSULE HAS TO REACH THE DELTOID. At radius A0*0.60 on a
     centre 50 mm below the station it was a stub buried 100 mm inside the
     flank, and the histogram showed armL0 winning ZERO vertices — the
     chest ball owned the whole shoulder and the arm started at the elbow.
     Full radius on the station itself: the shoulder now rotates with the
     arm, and the chest ball (r 0.198 about x 0) still owns the fillet
     inboard of it, which is what stops an opening arm dragging a bat wing
     out of the flank. */
  { name: 'armL0', parent: 'chest', w: [A[0][0], A[0][1], A[0][2]], bias: 0.008,
    cap: [['c', A[0][0], A[0][1], A[0][2], A[1][0], A[1][1], A[1][2], A[0][3] * 0.94, A[1][3] * 0.90]] },
  /* LIKENESS PASS 4 — THE ELBOW'S CAPTURE MUST NOT TOUCH THE FLANK. Its
     cone used to start at the ARMPIT station (x 0.218, r 0.053): inboard
     reach x 0.165, i.e. ON the flank wall (0.166) — so any elbow
     abduction dragged armpit-level flank skin with it, and the welcome
     pose tented a full bat-wing web from armpit to wrist (verified on
     pixels at both 20 and 30 degrees of elbow swing). The cone now
     starts just above the elbow pivot (upper station, inboard reach
     x 0.219): skin above it stays with the shoulder, the web cannot
     form, and the five weight-smoothing passes taper the hinge. */
  { name: 'armL1', parent: 'armL0', w: [A[2][0], A[2][1], A[2][2]],
    cap: [['c', A[2][0], A[2][1] + 0.024, A[2][2], A[3][0], A[3][1], A[3][2], A[2][3] * 0.82, A[3][3] * 0.95]] },
  /* LIKENESS PASS 4 — THE HAND'S CAPTURE MUST NOT TOUCH THE THIGH. At
     r 0.086 the cone's fat end reached inboard to x 0.162 — INSIDE the
     thigh's outer skin (0.196) — so the hand WON a sliver of thigh-front
     skin (weight-painted: the welcome web tents were hand-coloured, and
     they anchored at the hips, not the armpit). Hand-to-leg is six hops,
     over MAXHOP, so that sliver was 100% hand: in welcome the supinating
     mitten dragged it into a membrane from crotch to wrist, and in cool
     it tore the jagged seam on the inner thigh at (543, 940). r 0.052
     still covers the whole mitten — capture is competitive and no other
     volume comes near it — but leaves the thigh to legL0 by a clear
     margin. */
  /* BODY PASS: the capture follows the new PROP.hand stations exactly —
     wrist to tip down the mitten's own axis, plus a capsule down the
     thumb so the lobe rides with the hand rather than being fought over
     by the elbow. Radii stay UNDER the sculpt (0.046 against a 0.057
     knuckle) for the round-4 reason: the mitten's skin is still nearest
     this volume by a wide margin, and the thigh is left to legL0. */
  { name: 'handL', parent: 'armL1', w: [A[4][0], A[4][1], A[4][2]],
    cap: [['c', A[4][0], A[4][1], A[4][2],
           PROP.hand.tip[0], PROP.hand.tip[1] - 0.010, PROP.hand.tip[2],
           A[4][3] * 0.95, 0.062],
          ['c', PROP.hand.thumbA[0], PROP.hand.thumbA[1], PROP.hand.thumbA[2],
           PROP.hand.thumbB[0], PROP.hand.thumbB[1], PROP.hand.thumbB[2],
           0.030, 0.025]] },

  { name: 'legL0', parent: 'hips',  w: [L[0][0], L[0][1], L[0][2]],
    cap: [['c', L[0][0], L[0][1], L[0][2], L[1][0], L[1][1], L[1][2], L[0][3] * 0.86, L[1][3] * 0.92]] },
  { name: 'legL1', parent: 'legL0', w: [L[1][0], L[1][1], L[1][2]],
    cap: [['c', L[1][0], L[1][1], L[1][2], L[2][0], L[2][1], L[2][2], L[1][3] * 0.92, L[2][3] * 0.95]] },
  { name: 'footL', parent: 'legL1', w: [L[2][0], L[2][1] - 0.024, L[2][2]],
    cap: [['b', PROP.foot.c[0], PROP.foot.c[1], PROP.foot.c[2],
           PROP.foot.h[0], PROP.foot.h[1], PROP.foot.h[2], PROP.foot.r + 0.014]] },
];

function mirrorPrim(p) {
  const q = p.slice();
  if (q[0] === 's') { q[1] = -q[1]; }
  else if (q[0] === 'c') { q[1] = -q[1]; q[4] = -q[4]; }
  else if (q[0] === 'b') { q[1] = -q[1]; }
  return q;
}
function mirrorName(n) { return n.replace(/L(\d*)$/, 'R$1'); }

/** The full bone table: base + left + mirrored right, in parent-first order. */
export const BONES = (() => {
  const out = BASE_BONES.map((b) => ({ ...b }));
  for (const b of LEFT_BONES) out.push({ ...b });
  for (const b of LEFT_BONES) {
    out.push({
      name: mirrorName(b.name),
      parent: /L\d*$/.test(b.parent) ? mirrorName(b.parent) : b.parent,
      w: [-b.w[0], b.w[1], b.w[2]],
      cap: b.cap ? b.cap.map(mirrorPrim) : null,
      bias: b.bias,
    });
  }
  return out;
})();

export const BONE_INDEX = (() => {
  const m = Object.create(null);
  BONES.forEach((b, i) => { m[b.name] = i; });
  return m;
})();

/** Parent index per bone, -1 for the root. */
export const BONE_PARENT = BONES.map((b) => (b.parent == null ? -1 : BONE_INDEX[b.parent]));

/* Tree distance between every pair of bones. Skin weights are only ever
   shared between bones within 2 hops, which is what stops the trunk —
   which hangs a centimetre in front of the belly — from being weighted
   to the belly. */
export const BONE_DIST = (() => {
  const n = BONES.length;
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const p = BONE_PARENT[i];
    if (p >= 0) { adj[i].push(p); adj[p].push(i); }
  }
  const D = new Uint8Array(n * n).fill(255);
  for (let s = 0; s < n; s++) {
    D[s * n + s] = 0;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      const v = q[h];
      const dv = D[s * n + v];
      if (dv >= 3) continue;
      for (const w of adj[v]) {
        if (D[s * n + w] === 255) { D[s * n + w] = dv + 1; q.push(w); }
      }
    }
  }
  return D;
})();

/* Bones grouped by the chain they belong to — anim and secondary both
   want these by name rather than by index arithmetic. */
export const CHAINS = {
  earL: ['earL0', 'earL1', 'earL2'],
  earR: ['earR0', 'earR1', 'earR2'],
  trunk: ['trunk0', 'trunk1', 'trunk2', 'trunk3', 'trunk4'],
  tail: ['tail0', 'tail1', 'tail2'],
  armL: ['armL0', 'armL1', 'handL'],
  armR: ['armR0', 'armR1', 'handR'],
  legL: ['legL0', 'legL1', 'footL'],
  legR: ['legR0', 'legR1', 'footR'],
};

/* ------------------------------------------------------------------
   Capture-volume distance. Used by model.js when it bakes skin weights.
   ------------------------------------------------------------------ */
function dSphere(x, y, z, p) {
  const dx = x - p[1], dy = y - p[2], dz = z - p[3];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - p[4];
}
function dCone(x, y, z, p) {
  /* Round cone: exact for the cylindrical band, conservative at the caps
     — plenty for a weight field. */
  const ax = p[1], ay = p[2], az = p[3];
  const bx = p[4], by = p[5], bz = p[6];
  const ra = p[7], rb = p[8];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const uu = ux * ux + uy * uy + uz * uz || 1e-9;
  const px = x - ax, py = y - ay, pz = z - az;
  let t = (px * ux + py * uy + pz * uz) / uu;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = px - ux * t, cy = py - uy * t, cz = pz - uz * t;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) - (ra + (rb - ra) * t);
}
function dBox(x, y, z, p) {
  const qx = Math.abs(x - p[1]) - p[4];
  const qy = Math.abs(y - p[2]) - p[5];
  const qz = Math.abs(z - p[3]) - p[6];
  const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
  const outside = Math.sqrt(mx * mx + my * my + mz * mz);
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outside + inside - p[7];
}

/** Signed distance to a bone's capture volume set. +Infinity if it has none. */
export function captureDistance(bone, x, y, z) {
  const caps = bone.cap;
  if (!caps) return Infinity;
  let d = Infinity;
  for (let i = 0; i < caps.length; i++) {
    const p = caps[i];
    const v = p[0] === 's' ? dSphere(x, y, z, p)
      : p[0] === 'c' ? dCone(x, y, z, p)
        : dBox(x, y, z, p);
    if (v < d) d = v;
  }
  return d + (bone.bias || 0);
}

/* ------------------------------------------------------------------
   Skeleton construction
   ------------------------------------------------------------------ */

/**
 * Build the bone hierarchy at bind pose.
 * @returns {{ bones: THREE.Bone[], byName: Object, rootBone: THREE.Bone,
 *             bindPos: Float32Array, skeleton: THREE.Skeleton }}
 */
export function buildSkeleton() {
  const bones = [];
  const byName = Object.create(null);
  const bindPos = new Float32Array(BONES.length * 3);

  for (let i = 0; i < BONES.length; i++) {
    const def = BONES[i];
    const b = new THREE.Bone();
    b.name = def.name;
    const p = BONE_PARENT[i];
    const pw = p >= 0 ? BONES[p].w : [0, 0, 0];
    b.position.set(def.w[0] - pw[0], def.w[1] - pw[1], def.w[2] - pw[2]);
    /* Bind rotation is identity, always. See the header. */
    b.quaternion.identity();
    bindPos[i * 3] = b.position.x;
    bindPos[i * 3 + 1] = b.position.y;
    bindPos[i * 3 + 2] = b.position.z;
    bones.push(b);
    byName[def.name] = b;
    if (p >= 0) bones[p].add(b);
  }

  const rootBone = bones[0];
  rootBone.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  return { bones, byName, rootBone, bindPos, skeleton };
}

/** World bind position of a named bone (metres). */
export function bindWorld(name) {
  const b = BONES[BONE_INDEX[name]];
  return b ? b.w.slice() : [0, 0, 0];
}

export default { H, PROP, BONES, BONE_INDEX, BONE_PARENT, BONE_DIST, CHAINS, buildSkeleton, bindWorld, captureDistance };
