/* ============================================================
   bike.js — Wally's bicycle. A PROP, owned by the character layer.

   WHY IT LIVES HERE AND NOT IN world/ OR intro/
   ---------------------------------------------
   It is only ever in the frame when Wally is, it is parented under his
   root so it inherits his yaw and his lean, and its saddle height is a
   contract with a bone in rig.js. That makes it part of the character,
   not part of the city.

   THERE IS ONE BICYCLE IN THE GAME. src/character/anim.js has the
   'ride-bicycle' clip and the CLIP is shared verbatim — this module
   does not add a second riding animation, it extends the existing one
   into a locomotion ladder. The MODEL used to be one of two: the intro
   built its own wire-thin diagram (30 mm tubes, box spokes, a
   7-segment torus tyre) for a shot twelve metres away, while this one
   was built for the follow camera at four metres and fitted to a
   SPECIFIC pelvis — SADDLE, BARS and PEDAL below are published so
   wally.js can lift the skeleton onto them instead of guessing.

   `createBike` is exported and src/intro/shots.js now imports it: its
   private prop is gone and the opener rides this frame. The header used
   to argue against exactly that, on the grounds that "intro/shots.js
   belongs to another agent. Importing it would make the whole game fail
   to boot the moment they rename an export." Both files are now owned
   together and the import exists, so that paragraph described a world
   that no longer is; what it was protecting — the fit — is now checked
   by measurement instead (WALLY.debug.driveTrace).

   ------------------------------------------------------------------
   GEOMETRY BUDGET — MEASURED, 2026-08. The header used to claim
   "~1 900 triangles, 11 draw calls, five materials". Every one of those
   was wrong, in the one file whose job is to publish measured numbers.
   WALLY.debug.rideInfo().cost and a renderer.info difference say:

     53 body meshes           7 992 triangles    5 body materials
     53 outline hulls         7 992 triangles    5 hull materials  (§2.2)
     ------------------------------------------------------------
     106 meshes total        15 984 triangles   10 materials, 31 geometries

   The hulls are the inverted-hull stroke ART_DIRECTION §2.2 puts on
   world geometry; they are a second non-indexed copy of every painted
   mesh, and they are the reason the drawn figure is twice the model.

   COST IN A FRAME, re-measured 2026-08 by differencing renderer.info
   across two renders with the prop toggled, at 1280x720, dpr 1, with
   the machine STANDING ON THE TERRAIN at each range — which cascades a
   caster falls in depends on where it actually is, and the rig that
   produced the first version of this ladder dropped it at eye height,
   floating in the middle of the frustum.

   THE APPARENT HEIGHTS ARE THE PAINTED SILHOUETTE, and they are CSS
   pixels off the projected vertices (the column two generations back
   was drawing-buffer pixels at dpr 2, twice the truth; the one after it
   gathered the vertex list by traversing the WHOLE prop, so it carried
   the §2.2 inverted-hull shells — a hull is the same mesh pushed out
   along its normals — and came back about 3.5 % tall, at ranges where
   toon.js had already culled every hull and there was no stroke on
   screen at all). Painted vertices only, list re-gathered at every
   range, never captured once.

   AND THE WHOLE COLUMN IS ONE CAMERA NOW: the machine centred ON THE
   OPTICAL AXIS, which is the only geometry the thin-lens check below is
   exact in. The column that stood here was a mix — five of its eleven
   figures were the on-axis ones, two were from the level camera 2%
   above them, and 6 m was neither. Mixing them is not a rounding
   difference: it is two different measurements printed in one column
   with nothing saying which is which. 1280x720, dpr 1, fov 50, parked
   and standing on the terrain at each range:

     6 m,  127.72 px   212 calls, 31 968 tris   53 body + 53 hulls, x2 cascades
     12 m,  63.46 px   201 calls, 30 644 tris   11 hulls culled (+/-1 at the edge)
     18 m,  42.22 px   179 calls, 27 412 tris   33 hulls culled
     24 m,  31.63 px   172 calls, 26 268 tris
     32 m,  23.71 px   169 calls, 26 052 tris
     40 m,  18.96 px   163 calls, 24 556 tris
     46 m,  16.48 px   108 calls, 16 284 tris   out of the 2nd cascade
     55 m,  13.78 px   106 calls, 15 984 tris   no hulls left
     64 m,  11.84 px   106 calls, 15 984 tris   PARK_DRAW_M
     122 m,  6.21 px   106 calls, 15 984 tris   the §2.4 haze line
     145 m,  5.22 px   106 calls, 15 984 tris   parkedCull has it off by here

     off screen, under ~16 m   106 calls  (shadow only, two cascades)
     off screen, ~20 m          90 calls  (the cascade boundary)
     off screen, 24 to 80 m     53 calls  (shadow only, one cascade)
     off screen, 100 m and out   0 calls

   THE OFF-SCREEN COLUMN IS AT TIER "high", TWO CASCADES, and it had to
   be said: that column IS the cascade set and the cascade set is the
   tier (QUALITY_TIERS runs 1, 2, 2, 3 cascades). The machine auto-picks
   "high" on the rig this was taken on; WALLY.debug.renderInfo() prints
   the tier and the cascade count together. Re-measured twice against
   the live loop with a PRIVATE bicycle added to the scene — one
   parkedCull cannot touch, parked and stood on the terrain at each
   range — and the ~20 m row came back 90.0 and 90.7, which is the
   second cascade's far plane landing inside that rung rather than a
   third state. A ladder that reads FLAT at 53 across the whole near
   range was measuring a caster that never entered the second cascade.

   WHY THE AXIS AND NOT EYE HEIGHT: an object below the optical axis
   subtends tan(top) - tan(bottom), which is larger than h/d, so the
   same machine measures about 2% taller from a level camera at eye
   height — 5.22 px on the axis at 145 m against 5.32 level, 127.72
   against 129.20 at 6 m. Both columns are in the parked-cull note in
   wally.js, side by side with the geometry named against each; this one
   is the axis.

   A thin lens agrees with the whole column: 0.9806 m of parked machine
   at 772 px of focal length at fov 50 gives 0.9806*772/55 = 13.76
   against 13.78 measured, and 0.9806*772/145 = 5.22 against 5.22. That
   is a HUNDREDTH of a pixel, not the "tenth" that was claimed while the
   hulls were still in the list.

   THE PAINTED MACHINE IS 0.9806 m TALL PARKED AND 0.9544 m UPRIGHT, and
   the second of those is this round's correction — the note used to say
   1.03. It is also worth knowing WHY parked is the taller of the two,
   because it reads backwards: the lean is a roll about z, so it carries
   the machine's far side DOWN below the contact plane (4.4 mm of it,
   which is the same offset the kickstand note below is about) and
   swings the near bar end up. The span is between those. The 1.03 was
   never measured off a parked machine at all, and that is how a bad rig
   was once caught: a run reporting 84 px at 12 m also reported the
   machine 1.03 m tall — upright, therefore never parked, therefore
   being positioned in Wally's root frame instead of the world's.
   (Apparent height here is the projected span of the painted vertices;
   terrain occlusion is not modelled, so the 4.4 mm below the contact
   plane is counted even where the ground would hide it.)

   EVERY CALL FIGURE IS CROSS-CHECKED AGAINST REAL FRAMES, and it had
   to be: a judge re-measured this ladder at 156.7 calls at 17.7 m and
   95.5 at 32.9 m against the 179 and 169 here. Fractional call counts
   are an average, and averaging a machine that crosses the frustum
   edge mixes its in-frame cost with its 53-call off-screen one — 169
   and 53 average to about 95, which is the number that came back. So
   each rung is measured a second way, by toggling the prop onto an
   unused LAYER on alternate animation frames and averaging both sets:
   211.8 / 179.8 / 169.0 / 105.8 against 212 / 179 / 169 / 106. Where
   parkedCull has the machine switched off, the live figure correctly
   reads 0 while the two-render difference reports what it WOULD cost,
   which is exactly the distinction the two halves of this ladder draw.
   (Toggle by layer and put the MASK BACK, never layers.set(0):
   wally.js enables layer 9 on every mesh in a prop so the blob-shadow
   projector can see it, and wiping that quietly changes the scene for
   every rung measured after the first.)

   TWO INSTRUMENT TRAPS ARE BAKED INTO THOSE NUMBERS, and both of them
   produced a wrong ladder first. renderer.js sets info.autoReset =
   false, so every render has to be bracketed by an explicit
   info.reset() or the counts accumulate across passes. And it sets
   shadowMap.autoUpdate = false, raising needsUpdate once per frame —
   so a tool that calls renderer.render() itself and does not raise it
   reuses the last frame's shadow maps, which silently deletes the
   whole right-hand column above and reports 0 calls off screen at
   every range. A third: toon.js culls the §2.2 hulls once per FRAME,
   so a camera moved inside one synchronous evaluate measures the hull
   set from wherever the camera was last frame and the ladder comes
   back flat at 106. Move the PROP and let the loop run.

   Two parked machines and a ridden one is three of these. The
   off-screen figures are new: every mesh here used to carry
   frustumCulled = false, so a bicycle parked BEHIND the camera cost
   199 draw calls and 30 751 triangles a frame. See `finish` at the
   foot of this file, and parkedCull() in wally.js for the rest of the
   policy — it hides a parked machine past 64 m when it is out of
   frustum, which is what takes that 53 to 0 in practice. Built once at
   boot, hidden until the player owns and equips it.

   FORWARD IS +Z, matching Wally's root and every building on the
   island. Origin is on the ground directly under the bottom bracket.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BUILD, LAND, BRAND } from '../core/palette.js';

/* ------------------------------------------------------------------
   THE THREE NUMBERS ANOTHER MODULE IS ALLOWED TO DEPEND ON.

   SADDLE.y is where the hips bone has to end up. wally.js reads it,
   measures where the ride clip actually puts the pelvis, and lifts the
   skeleton's root bone by the difference — so if this frame is ever
   re-proportioned, the rider follows it without a second number being
   edited anywhere.
   ------------------------------------------------------------------ */
/* MEASURED OFF THE RIDER, NOT CHOSEN. WALLY.debug.bikeInfo() reports
   where his hips, feet and hands actually are in the riding pose, in
   root-local metres; these are those numbers.

   THE FIT, WITH THE NUMBER THAT IS ACTUALLY MEASURED. This note used to
   say "the ankle sits within 22 mm of the pedal through the whole
   stroke". WALLY.debug.driveTrace() reports two figures and 22 was the
   wrong one of them: `fitDriftMM` — how far the ankle-to-pedal offset
   VECTOR wanders about its own mean — is 23.5 mm, and `fitMaxMM` — the
   worst GAP between ankle and pedal plate over the stroke — is 50.2 mm
   (14.4 mm at its closest). The drift is what says the foot does not
   slide off the pedal; the gap is a foot standing on a plate with a
   sole between them, and it never was 22 mm. Both are in tolerance.
   Quote the one you mean.

   The grips are under the mittens, which together with the above is the
   difference between a rider and a man hovering near a bicycle.

   THE BARS ARE SWEPT BACK, and that is a consequence rather than a
   style choice: his arms are 0.30 H long on a body with a head-ball
   0.348 H across, so his hands come to rest 0.90 m up and only 0.35 m
   forward. A bar that reached out to the head tube would need arms he
   does not have. Swept-back bars — a Dutch city bike — put the grips
   exactly where the hands already are, and they suit the front basket,
   the upright back and the whole shape of the animal. */
export const SADDLE = { x: 0, y: 0.465, z: -0.075 };
export const BARS = { x: 0.352, y: 0.882, z: 0.278 };
export const PEDAL = { y: 0.215, z: 0.030, r: 0.078 };

const R = 0.225;             // wheel radius, tyre included
const BASE = 0.94;           // axle to axle
const AXZ = BASE * 0.5;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/* ==================================================================
   THE PARKED-MACHINE POSE SOLVE — ONE COPY, TWO CALLERS.

   wally.js parkProp() and intro.js parkArrival() both stand a machine
   on the ground and both used to carry their own transcription of this
   arithmetic. They diverged: the intro's copy shipped a generation
   behind with a 14.9-degree clamp the stage picker could exceed by half
   again, and it was missing the second sampling pass entirely. Two
   copies of a solve is how a bicycle ends up buried 340 mm at a mark
   the other copy handles. One copy, here, imported by both.

   ------------------------------------------------------------------
   WHY IT ITERATES, AND WHAT THE OLD TWO-PASS SOLVE ACTUALLY DID
   ------------------------------------------------------------------
   Rotating about the origin shortens each contact's horizontal reach to
   z*cos(pitch), so the heights that SET the pitch are not read where
   the wheels COME TO REST. The old solve took one correction pass for
   that and stopped, and its own header called the result "zero to the
   tenth of a millimetre everywhere inside the clamp" over 78 869 sites.

   IT WAS SAMPLING THE LATTICE, AND THE REASON THAT HID THE DEFECT IS
   NOT THE ONE THIS NOTE USED TO GIVE. terrain.js's heightAt is a
   piecewise PLANAR triangulated raster on CELL = 2 m, split fz <= fx
   inside each cell. That census stepped 10 m — which divides 2 exactly
   — on four axis-aligned headings, and this note said that "keeps BOTH
   wheel contacts inside the same terrain triangle". Measured on that
   exact grid, through the real park path: the two contacts are in
   DIFFERENT triangles at 5 806 of 5 806 sites. 100%, not 0%. A story
   that was the wrong way round is worse than no story, because the next
   reader tests for the wrong thing.

   WHAT ACTUALLY MAKES IT EXACT IS THE ORIGIN LANDING ON A GRID LINE.
   A step that divides CELL, on an axis heading, puts the machine's
   origin exactly on a cell boundary normal to the heading (measured:
   offset 0.000000 cells at 5 806 of 5 806 sites; off the lattice, 0 of
   10 912). The height along the heading is then linear on EACH SIDE of
   the origin over the whole reach — H(t*u) - h0 = t*(H(u) - h0), which
   held to the bit at 5 806 of 5 806 lattice sites and at only 2 935 of
   10 912 off it. That is homogeneity about the origin, and it is all
   the sin/tan cancellation ever needed: contracting both reaches by
   cos(p) scales the chord's rise by exactly cos(p), so pass two hands
   back pass one's own pitch. Measured: p2 == p1 to the bit at every
   lattice site, the reach never moves at all, and the two-pass residual
   is 0.000 mm. Off the lattice p1 and p2 differ by up to 26.2 degrees.
   The census could not have found the defect it was run to rule out —
   not because the wheels shared a triangle, which they never did, but
   because its own grid put the breakpoint under the machine.

   Measured OFF the lattice — 7.3 m grid, offset 0.37 m, five headings
   that are not multiples of pi/2, the 10 937 sites the solve leaves
   inside the clamp on the bicycle, both contacts each: 1 085 contacts
   over 0.1 mm, 142 over 10 mm, WORST 909.7 mm, and 237 contacts more
   than a millimetre UNDER the terrain, worst -673.2 mm. It is not a
   steep-ground-only fault: the mildest ground carrying more than a
   millimetre of it reads 5.9 degrees off level under the machine, and
   more than ten millimetres 8.3. In the 44-48 degree band the old note
   calls exact there are 49 sites on this grid and three of them put
   BOTH wheels under the terrain, inside the clamp: -101.2/-80.6 at
   45.43 degrees, -24.5/-262.5 at 44.91 and -50.2/-14.3 at 45.70. All
   three read 0.0/0.0 through the solve below.

   (1 085 AND 237, NOT THE 920 AND 233 THIS NOTE USED TO CARRY, and the
   cause is worth naming because it is a trap any successor will walk
   into: the census read each contact's error off parkProbe, which
   published it at toFixed(1). Every error from 0.100 to 0.149 mm
   rounded down and fell out of an "over 0.1 mm" bucket. Threshold the
   same 21 874 values after rounding them and the count comes back 929;
   threshold them unrounded and it is 1 085. Every worst-case figure was
   right all along — a worst case survives rounding. parkProbe now
   publishes four decimals for this reason.)

   ON ROADS IT WAS ALREADY FINE, and that sentence needs its population
   stated. See the note below on what world.isRoad actually returns:
   restricted to the 533 sites of this grid where a machine could really
   be left, 22 contacts of 1 066 were over 0.1 mm and 2 over 1 mm, worst
   -1.72 mm. That is why nothing was ever visible in play — machines are
   parked at doors, and doors are the flattest ground on the island.

   AFTER, on three different off-lattice grids so the answer cannot be
   an artefact of one of them — every site run through the real
   WALLY.debug.parkProbe path, every contact then measured in the TOOL
   from the prop's own world matrix against ctx.world.heightAt at its
   own world position:

     grid / offset / heading set    sites    contacts   >0.1mm   worst
     7.3 m, 0.37, five headings    10 937     21 874       0      0.0
     3.1 m, 0.83, golden angle     60 507    121 014       0      0.0
     10.3 m, 1.41, golden angle     5 482     10 964       0      0.0

   153 852 contacts, and the same on the scooter (21 870) and the
   motorcycle (21 874). Zero over a TENTH of a millimetre, nothing
   buried anywhere, restricted road and whole island alike — on the
   7.3 m grid the restricted road population is 1 066 of those contacts
   and it is zero too. Sites where the clamp saturates are counted out
   and reported separately (298 of 11 235 on the 7.3 m grid); past the
   clamp the residual is a bad sample, not a street, and the lift keeps
   it above ground.

   THE POPULATION IS ONE POPULATION. Every before/after pair in this
   header is the same set of sites — the ones the CURRENT solve leaves
   unclamped — measured with the same ruler. The old note's before and
   after halves were not: the before was filtered by a `clamped` flag
   the probe re-decided from the RIDER's chord, 0.62 m from the machine
   and on a different hill, which is the very defect the probe's own
   header documents.

   The residual has a closed form, and it is what tells you the fix.
   With gy set from the pass-one samples hf, hr and the pass-two pitch
   p2, each contact's error is exactly

       e = H(z*cos p1) - H(z*cos p2)

   — pure terrain difference between where the height was READ and where
   the wheel LANDS.

   IT VANISHES WHEN p2 == p1, AND ONLY THEN, which is not the same claim
   as "when the two reaches share a triangle" and this header made the
   wrong one. Sharing a triangle is not sufficient: inside one triangle
   the ground is an affine plane, so a wheel whose whole reach segment
   stays on it still carries gradient x z x (cos p1 - cos p2), and that
   is zero only if the two pitches agree. Measured on the 7.3 m grid,
   both contacts at every unclamped site: 13 contacts of 21 874 have
   their pass-one and pass-two reach points on different triangles,
   while 1 085 carry more than 0.1 mm of error. The straddle explains
   under 1% of it. (The wheel-to-wheel straddle the paragraph above is
   about is a different count again and a common one — 7 988 of those
   10 937 sites, 73%, have their two contacts on different triangles
   off the lattice, and 100% do on it. Three different triangle
   questions live in this solve and only one of them is the residual's.)

   What DOES make p2 == p1 is all four samples lying on one affine piece
   of the terrain — one plane, where the sin and the tan cancel exactly
   — or the origin sitting on a cell boundary, where the profile is
   homogeneous about it and they cancel just the same (the lattice case
   above). Neither is generic, and where neither holds the residual is
   the local gradient times the change in reach, which at 45 degrees is
   150 mm of reach.

   So it is a fixed point, not a fixed number of passes:

       p  =  asin( (H(zr*cos p) - H(zf*cos p)) / base )

   iterated until it stops moving. Where the iteration OSCILLATES — the
   map is not a contraction across a slope break — it falls back to
   bisection, which is safe here for a reason worth stating: heightAt is
   C0 continuous (the two triangles of a cell agree along their shared
   diagonal, adjacent cells along their shared edge), so
   f(p) = asin(...) - p is continuous in p and a sign change brackets a
   root. 60 halvings put it at float precision.

   AND NOTHING IS EVER BURIED, on any path. The old lift was gated on
   the clamp being saturated, on the argument that inside the clamp both
   residuals were zero — true on the lattice, false off it. The lift is
   now unconditional and computed from the contacts' OWN residuals, so
   it is a no-op wherever the iteration converged (which is almost
   everywhere) and it catches the ridge cases where no pitch puts both
   wheels down at once.

   ------------------------------------------------------------------
   THE ROLL, WHICH NOBODY WAS SOLVING AT ALL
   ------------------------------------------------------------------
   The pitch was conformed from two wheel samples and the LEAN was a
   constant, so the side stand — which sits 0.23 to 0.34 m out to the
   side — rode the machine's own contact plane instead of the terrain.
   Measured on the same off-lattice census, bicycle, whole island, the
   design contact point: it averaged 37.3 mm off the ground with 23.4%
   of sites hovering over 20 mm — and 24.7% of them more than 20 mm INTO
   the ground, which the old row did not mention — with BOTH WHEELS
   reading 0.0, so the probe that had been signing this feature off was
   measuring two legs of a three-legged pose. On restricted road:
   15.4 mm mean, 10.5% hovering over 20 mm, 14.3% sunk over 20 mm.
   Two rounds ago the whole point of reviving
   this pose was that a machine leaning on a stand tells a story, and
   that round found the stand on the opposite side from the lean. A
   stand hovering a metre and a half in the air is the same defect in a
   different hat.

   It is solved the way the pitch is: from samples, not from taste. The
   foot's design contact point is the stand tube's far endpoint, which
   each prop places on its own contact plane at its own lean (y =
   -x*tan(lean)). Roll it by r and that point sits at

       Y = x0 sin r + y0 cos r     over a ground of  t(u) = t0 + g*u

   which solves to r = asin(t0/hypot(A,B)) - atan2(B, A) with
   A = x0 + g*y0 and B = y0 - g*x0. With t0 = 0 and g = tan(phi) that
   reduces to r = lean + phi EXACTLY — the machine keeps its own lean
   and takes on the ground's cross-slope, which is what a machine
   standing on a hill does. t0 is carried because the pitch chord is
   exact only AT the two wheels and the stand is between them.

   IT IS CLAMPED TO A BAND AROUND THE LEAN, and the floor matters more
   than the band: the lean is negative on all three machines, a roll on
   the wrong side of zero would tip the machine onto the side with no
   stand under it, so the roll is never allowed nearer upright than
   PARK_ROLL_MIN. Past the band the foot hovers or sinks and the machine
   still reads as leaning, which is the right way round to fail.

   BOTH LIMITS WERE SET FROM THE DISTRIBUTION AND THEN LOOKED AT. On
   restricted road the cross-slope the stand asks for is -7.9 degrees at
   the 5th percentile, -0.03 at the median and +11.0 at the 95th, so a
   0.26 rad band covers the lean-further side almost entirely; the floor
   binds more often than the band does (2 514 sites against 755 on the
   7.3 m grid) because ground RISING under the stand pushes the machine
   upright fast. Both ends were then screenshotted rather than argued
   about: at the band edge (roll -21.4 deg, ground falling 14 deg under
   the stand) the bicycle reads as a machine leaning hard on its stand
   on a hillside, and at the floor (roll -2.0 deg, ground rising 14 deg)
   it reads as one standing nearly upright on a beach with the stand
   just touching. Neither reads as fallen over.

   ------------------------------------------------------------------
   MEASURED, bicycle, 7.3 m off-lattice grid, 10 937 unclamped sites,
   the stand's DESIGN contact point against heightAt at its own world
   position. BEFORE is the same pose with the roll taken back to the
   constant lean — same sites, same pitch, same height, one variable —
   AFTER is this solve. Road is the restricted population.

                     island                    restricted road
                mean   hover>20  sunk>20    mean  hover>20  sunk>20
   const lean   37.3     23.4%    24.7%     15.4   10.5%    14.3%
   conformed    17.0      4.2%    12.5%      3.6    0.2%     5.6%
   ...unclamped  0.26     0%       0%        0.08   0%       0%

   THE SUNK COLUMN IS NEW AND IT IS THE POINT OF THIS REVISION. The old
   table published hover only, and the summary under it said the foot
   ends "a few millimetres into the ground on flat and on slope alike,
   which is invisible and never hovers". Half of that is true. The roll
   floor exists to stop a machine tipping onto its standless side, and
   where the ground RISES under the stand the floor holds the machine
   upright and drives the foot into the hill: 5.6% of restricted road
   sites put it more than 20 mm in, worst -236 mm. Both tails are the
   clamp doing its job — the island tail is a stand over a cliff edge or
   inside a wall, where no roll in a sane band reaches the ground — but
   a reader cannot tell a designed limit from a defect if only one side
   of it is printed.

   87% of restricted road sites are unclamped in roll and average
   0.08 mm off the ground, worst hover 1.2 mm and worst sink -6.4 mm.
   Scooter and motorcycle come back at 3.66 and 3.35 mm restricted-road
   mean, 0.2% hovering over 20 mm, 5.3% and 3.8% sunk over 20 mm. On a
   second grid (10.3 m, offset 1.41, golden-angle headings) the same
   columns read 17.2 / 4.1% island and 3.9 mm / 0.8% road, and on a
   third (3.1 m, 0.83) 17.3 / 4.3% and 5.0 mm / 1.6%.

   WHAT "ROAD" MEANS HERE, because it decides every road figure above.
   world.isRoad is terrain.pathAt > 0.35 — a test on the painted path
   texture, which answers TRUE inside building footprints and on grades
   nothing can stand on. Unfiltered it gives 671 sites on this grid; 137
   of them overlap a city building's world box and one is over
   controller.js's 48-degree slopeLimit — and BOTH of that population's
   extremes are among the excluded: its worst hover (88.8 mm) is inside
   a building box and its worst sink (-403 mm) is the site over the
   slope limit. Quoting a percentile off a population whose tails are
   places nothing can park is how the next round starts chasing a ghost.
   The restricted population is
   the remaining 533: road under the MACHINE (not under the rider, who
   is 0.62 m away — the old census tested one and measured the other,
   which is where its 660-site, 1 320-contact road population came
   from), clear of every building box by half a machine, and under the
   slope limit. Unrestricted, the same after-column reads 4.00 mm mean
   and its worst sink is -403 mm at a site on 63.6 degrees of ground.
   ------------------------------------------------------------------

   FLAT GROUND IS UNCHANGED, AND THE ISLAND HAS NONE. With t0 = 0 the
   solve reduces to r = lean + phi EXACTLY, so the deviation from the
   shipped lean IS the ground's cross-slope under the stand — zero only
   where that is zero. The bound is therefore |r - lean| <= |phi| +
   |asin(t0/hypot(A,B))|, not zero, and on this island phi is never
   quite zero: on the flattest restricted-road site (terrain normal
   0.075 degrees off vertical) the roll comes back -7.61 against a -7.45
   lean. Nor is the intro's hero mark an exception — it is the loudest
   case: measured through the shipped opener, the arrival bicycle stands
   at roll -6.105 against the -7.4485 lean, because its pad carries
   1.343 degrees of cross-slope under the stand. r - lean = phi, to
   three decimals, on the one pose this note claimed was untouched. See
   parkArrival in intro.js, which has had the right number all along.

   WHAT THE PROBE MEASURES IS THE PAINTED SURFACE, AND THAT IS NOT THIS
   POINT. The design contact point is the capsule's axis tip; the lowest
   PAINTED vertex of the tessellated stand sits 4.71 mm below it on the
   bicycle, 5.18 on the scooter and 5.22 on the motorcycle, measured in
   the prop's own frame at its own lean. (This note used to say 4.4 /
   5.6 / 5.1. Those are the offsets below the nominal contact plane
   y = 0, and the design point is not on it: PARK_FOOT's y is written to
   the millimetre, so the tip sits +0.27 mm above the plane on the
   bicycle, -0.41 below on the scooter and +0.08 above on the
   motorcycle. 4.44 + 0.27, 5.59 - 0.41, 5.14 + 0.08. The datum was
   never stated, and the two datums disagree by more than the difference
   the numbers were quoted to.) The offset is by design and predates
   this solve — conforming the painted vertex instead would stand the
   bicycle and the scooter 1.11 degrees more upright than their
   documented lean and the motorcycle 0.87.

   SO THE PAINTED FOOT IS ALWAYS SLIGHTLY IN THE GROUND, and that is
   what the eye sees rather than the design point: the closest approach
   of the painted stand to the terrain has a median of -4.71 mm on
   restricted road with a 95th percentile of -4.39 — a third of a
   millimetre of spread around the design offset, which is invisible.
   The tail is the roll clamp again, not the offset: 6.4% of restricted
   road sites are more than 20 mm in.
   ================================================================== */
export const PARK_PITCH_MAX = 0.838;   // 48 deg = controller.js slopeLimit
export const PARK_ROLL_BAND = 0.26;    // rad the roll may leave the lean by
export const PARK_ROLL_MIN = 0.035;     // rad: never nearer upright than this

const _cl = (v, a, b) => (v < a ? a : (v > b ? b : v));

/**
 * @param {(x:number,z:number)=>number} H terrain height; non-finite means
 *        "no terrain here" and the solve keeps what it had.
 * @param {object} o
 *   x, z, yaw   where the machine goes and which way it faces (+z forward)
 *   zf, zr      front / rear contact z in the machine's own frame
 *   lean        the prop's parked roll on z (rad, negative on all three)
 *   foot        {x, y, z} the stand's design contact point, prop-local,
 *               or null for a machine with no stand
 *   fallbackY   height to use if the terrain will not answer
 */
export function solveParkPose(H, o) {
  const zf = o.zf, zr = o.zr, base = zf - zr;
  const yaw = o.yaw;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);     // local +z, in world
  const lx = Math.cos(yaw), lz = -Math.sin(yaw);    // local +x, in world
  const pitchMax = Number.isFinite(o.pitchMax) ? o.pitchMax : PARK_PITCH_MAX;
  const S = (px, pz) => { const h = H(px, pz); return Number.isFinite(h) ? h : NaN; };

  const g0 = S(o.x, o.z);
  let y = Number.isFinite(g0) ? g0 : o.fallbackY;
  let pitch = 0, raw = 0, clamped = false, iters = 0, bisected = false;
  let hf = NaN, hr = NaN, lift = 0, ef = 0, er = 0;

  if (base > 0.05) {
    /* the implied pitch at a trial pitch, with the contacts sampled
       where that trial actually puts them */
    const impAt = (p) => {
      const c = Math.cos(p);
      hf = S(o.x + fx * zf * c, o.z + fz * zf * c);
      hr = S(o.x + fx * zr * c, o.z + fz * zr * c);
      return (Number.isFinite(hf) && Number.isFinite(hr))
        ? Math.asin(_cl((hr - hf) / base, -1, 1)) : NaN;
    };
    const seed = impAt(0);
    if (Number.isFinite(seed)) {
      /* SIGN, DERIVED AND THEN MEASURED. Three.js's Rx sends (0, 0, L)
         to y' = -L*sin(x), so a POSITIVE rotation.x pushes the +z end
         DOWN. Forward is +z, so nose-up on rising ground is a NEGATIVE
         pitch. An earlier version of this line had it the other way
         round and the probe caught it at once: on a 14.6-degree
         hillside it turned the front wheel's -84 mm error into -176 mm.
         Reasoning about a rotation sign is how the pedalling-backwards
         bug lived as long as it did; measure both wheels afterwards. */
      let p = _cl(Math.atan2(hr - hf, base), -pitchMax, pitchMax);
      let imp = seed, prevP = NaN, prevF = NaN;
      /* 60, not 24. The map contracts fast almost everywhere and exits
         in 2 or 3, but where the slope break makes it nearly
         non-contracting it creeps: the cap used to be 24 and two
         contacts of 21 874 on the motorcycle came out of it still
         0.7 mm short. Each extra turn is two heightAt calls on a site
         that already needed twenty of them, once per dismount. */
      for (iters = 1; iters <= 60; iters++) {
        imp = impAt(p);
        if (!Number.isFinite(imp)) { imp = raw; break; }
        const next = _cl(imp, -pitchMax, pitchMax);
        const f = next - p;
        if (Math.abs(f) < 1e-9) break;
        if (Number.isFinite(prevF) && (prevF > 0) !== (f > 0)) {
          bisected = true;
          let lo = prevP, hi = p, flo = prevF;
          for (let k = 0; k < 60; k++) {
            const mid = (lo + hi) * 0.5;
            const im = impAt(mid);
            const fm = (Number.isFinite(im) ? _cl(im, -pitchMax, pitchMax) : mid) - mid;
            if (fm === 0) { lo = mid; hi = mid; break; }
            if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
          }
          p = (lo + hi) * 0.5;
          break;
        }
        prevP = p; prevF = f;
        p = next;
      }
      pitch = p;
      /* RE-SAMPLE AT THE PITCH THAT IS ACTUALLY BEING USED, and this
         line is not tidiness. `p` advances after impAt has already
         written hf and hr for the PREVIOUS trial, so any exit that is
         not the |f| < 1e-9 one — the iteration cap, the bisection —
         leaves hf and hr belonging to a pitch the machine is not at.
         The residual below is then computed against the wrong pair and
         comes back 0.0 on a contact that is really 0.7 mm under the
         ground, and the lift, which reads that residual, does nothing
         about it. That is the same shape as the census that started all
         this: a number that agrees with itself because it was taken
         where the answer is free. */
      imp = impAt(pitch);
      raw = Number.isFinite(imp) ? imp : pitch;
      clamped = Math.abs(raw) > pitchMax + 1e-9;
      if (Number.isFinite(hf) && Number.isFinite(hr)) {
        y = (hf + hr) * 0.5 + (zf + zr) * 0.5 * Math.sin(pitch);
        /* each contact against the height it was built from — the real
           errors, not a model of them */
        ef = y - zf * Math.sin(pitch) - hf;
        er = y - zr * Math.sin(pitch) - hr;
        const sag = Math.min(ef, er);
        if (sag < 0) { y -= sag; lift = -sag; ef -= sag; er -= sag; }
      }
    }
  }
  if (!Number.isFinite(y)) y = o.fallbackY;
  if (!Number.isFinite(pitch)) pitch = 0;

  /* ---- the lateral half: put the stand foot on the ground ---- */
  const lean = Number.isFinite(o.lean) ? o.lean : 0;
  let roll = lean, rollRaw = lean, rollClamped = false;
  const F = o.foot;
  if (F && Math.abs(F.x) > 0.02) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    /* the machine's own y = 0 plane at the foot's z is a HORIZONTAL
       line along local +x — rotation order is YXZ, so the lateral axis
       is still level after the yaw and the pitch. */
    const bx = o.x + fx * F.z * cp, bz = o.z + fz * F.z * cp;
    const planeY = y - F.z * sp;
    const tAt = (u) => {
      const h = H(bx + lx * u, bz + lz * u);
      return Number.isFinite(h) ? h - planeY : NaN;
    };
    const t0 = tAt(0);
    if (Number.isFinite(t0)) {
      let u = F.x, solved = NaN;
      /* three passes: the chord is re-read where the roll actually puts
         the foot, the same correction the pitch takes for its reach */
      for (let k = 0; k < 3; k++) {
        const tu = tAt(u);
        if (!Number.isFinite(tu) || Math.abs(u) < 1e-3) break;
        const g = (tu - t0) / u;
        const A = F.x + g * F.y, B = F.y - g * F.x;
        const m = Math.hypot(A, B);
        if (m < 1e-6) break;
        const r = Math.asin(_cl(t0 / m, -1, 1)) - Math.atan2(B, A);
        if (!Number.isFinite(r)) break;
        solved = r;
        const nu = F.x * Math.cos(r) - F.y * Math.sin(r);
        const done = Math.abs(nu - u) < 1e-5;
        u = nu;
        if (done) break;
      }
      if (Number.isFinite(solved)) {
        rollRaw = solved;
        const band = Number.isFinite(o.rollBand) ? o.rollBand : PARK_ROLL_BAND;
        const floor = Number.isFinite(o.rollMin) ? o.rollMin : PARK_ROLL_MIN;
        roll = _cl(solved, lean - band, lean + band);
        roll = lean < 0 ? Math.min(roll, -floor) : Math.max(roll, floor);
        rollClamped = Math.abs(roll - solved) > 1e-6;
      }
    }
  }

  return {
    y, pitch, roll, rawPitch: raw, clamped, pitchIters: iters, bisected,
    contactMM: [+(ef * 1000).toFixed(3), +(er * 1000).toFixed(3)],
    liftMM: +(lift * 1000).toFixed(3),
    rollRaw, rollClamped,
  };
}

export function createBike(ctx, opts = {}) {
  const T = THREE;
  const group = new T.Group();
  group.name = 'wally.bike';
  const owned = [];
  const mats = [];

  /* ================================================================
     Materials — §5's five, three of which apply here.

     PAINTED for the frame (it is a manufactured, painted object, same
     family as a shutter or a market stall), WEATHERED WOOD for the
     saddle and the basket, and a matte near-black rubber for the tyres
     that is NOT pure black (§7).

     GRAIN. toon.js delivers the normal perturbation as `uGrain * 34`,
     so these are amplitudes in units of 1/34: 0.0011 * 34 = 0.037 on
     the frame, a fine paint tooth you can see at a 2x crop and not at
     four metres. The intro's bicycle passes 0.35 here, which is a
     perturbation of six radians — it scrambles the normal outright.
     Do not copy that number.

     OUTLINED, unlike Wally. §2.2 puts the inverted-hull stroke on world
     geometry and §1.2 forbids it on the clay; a bicycle is a made
     object, so it takes the stroke and the character it carries does
     not. That contrast is also what stops the two fusing into one grey
     mass in the follow camera.
     ================================================================ */
  const paint = (color, o = {}) => {
    const m = ctx.mat.toon({
      name: 'bike.paint',
      color,
      term: 0.17, bandSoft: 0.075, band2: 0.13,
      spec: 0.16, specPow: 30, specBanded: true,
      rim: 0.34,
      skyBounce: 0.16,
      grain: 0.0011, grainScale: 21, grainAlbedo: 0.055, grainShade: 0.16,
      grainFade: [26, 96],
      outline: true, outlineWidth: 3.0,
      ...o,
    });
    mats.push(m);
    return m;
  };

  const frameMat = paint(BRAND.token, { name: 'bike.frame' });
  const metalMat = paint(BUILD.metal, {
    name: 'bike.metal', spec: 0.30, specPow: 40, specBanded: true, rim: 0.46,
    grain: 0.0006, grainScale: 26, grainAlbedo: 0.035,
  });
  /* §7: never pure black. #3a3c41 through the shade law still reads as
     rubber and never bottoms out. */
  const tyreMat = paint(LAND.rockShade, {
    name: 'bike.tyre', color: 0x3a3c41,
    spec: 0.05, specPow: 14, rim: 0.22,
    grain: 0.0016, grainScale: 30, grainAlbedo: 0.070, grainShade: 0.22,
  });
  const woodMat = ctx.mat.wood
    ? ctx.mat.wood({ name: 'bike.saddle', color: BUILD.woodDark, outline: true, outlineWidth: 3.0 })
    : paint(BUILD.woodDark, { name: 'bike.saddle' });
  const basketMat = ctx.mat.wood
    ? ctx.mat.wood({ name: 'bike.basket', color: BUILD.wood, woodScale: 2.2, outline: true, outlineWidth: 3.0 })
    : paint(BUILD.wood, { name: 'bike.basket' });
  if (ctx.mat.wood) { mats.push(woodMat, basketMat); }

  /* ================================================================
     One capsule, re-oriented per tube. CHUNKY AND ROUNDED IS THE
     WHOLE BRIEF: a cylinder ends in a flat disc and every joint in
     the frame then shows a visible polygon cap (§7). A capsule ends
     in a hemisphere, so two tubes meeting at an angle blend into a
     soft knuckle without a fillet, which is exactly how the world's
     posts and railings are built.
     ================================================================ */
  const capCache = new Map();
  function capsuleGeo(r, len) {
    const key = `${r.toFixed(3)}|${len.toFixed(3)}`;
    let g = capCache.get(key);
    if (!g) {
      g = new T.CapsuleGeometry(r, Math.max(len - r * 2, 0.001), 3, 10);
      owned.push(g);
      capCache.set(key, g);
    }
    return g;
  }

  function tube(parent, a, b, r, mat) {
    _a.fromArray(a); _b.fromArray(b);
    _d.subVectors(_b, _a);
    const len = _d.length();
    const m = new T.Mesh(capsuleGeo(r, len), mat);
    m.position.copy(_a).addScaledVector(_d, 0.5);
    m.quaternion.setFromUnitVectors(UP, _d.normalize());
    parent.add(m);
    return m;
  }

  /* ================================================================
     Wheels — fat, soft-shouldered, five chunky spokes.

     THE TYRE IS A THICK TORUS, NOT A HOOP. 72 mm of section on a
     315 mm wheel is a balloon tyre: it reads as one rounded volume at
     any distance, it catches the terminator across its section the way
     every other rounded form in the game does, and it survives being
     four pixels tall in a vista. A 46 mm hoop at seven radial segments
     — the intro's — is a wire ring that aliases into dashes.
     ================================================================ */
  const tyreGeo = new T.TorusGeometry(R - 0.058, 0.058, 9, 26);
  const rimGeo = new T.TorusGeometry(R - 0.122, 0.026, 6, 22);
  const hubGeo = new T.CapsuleGeometry(0.042, 0.048, 3, 10);
  owned.push(tyreGeo, rimGeo, hubGeo);

  const wheels = [];
  for (const s of [1, -1]) {
    const w = new T.Group();
    w.position.set(0, R, s * AXZ);
    const tyre = new T.Mesh(tyreGeo, tyreMat);
    tyre.rotation.y = Math.PI / 2;
    const rim = new T.Mesh(rimGeo, metalMat);
    rim.rotation.y = Math.PI / 2;
    const hub = new T.Mesh(hubGeo, metalMat);
    hub.rotation.z = Math.PI / 2;
    w.add(tyre, rim, hub);
    const sr = R - 0.122;
    for (let i = 0; i < 5; i++) {
      const sp = new T.Mesh(capsuleGeo(0.015, sr * 2), metalMat);
      sp.rotation.x = (i / 5) * Math.PI;
      w.add(sp);
    }
    group.add(w);
    wheels.push(w);
  }

  /* ================================================================
     Frame. A step-through loop, not a diamond: it is rounder, it is
     what a city bike is, and it leaves the space between saddle and
     bars empty so the RIDER reads instead of a lattice of tubes in
     front of his belly.
     ================================================================ */
  const BB = [0, PEDAL.y, PEDAL.z];
  const CROWN = [0, 0.318, 0.392];               // fork crown / bottom of head tube
  /* A SLACK HEAD ANGLE — the tube leans BACK as it rises and the fork
     rakes forward from the crown. That is what a city bike does, and
     here it is also what lets the bar centre sit at z 0.330 (where a
     stem can reach it) while the front axle is out at 0.470 (where the
     wheelbase needs it). A vertical head tube would have put the stem
     behind its own steerer. */
  const HEAD_HI = [0, 0.742, 0.338];             // top of head tube
  const BAR_C = [0, BARS.y, BARS.z + 0.055];     // bar centre, ahead of the grips
  const SEAT_HI = [SADDLE.x, SADDLE.y - 0.042, SADDLE.z];
  const KNEE = [0, 0.415, 0.170];                // the step-through's low point
  const RAX = [0, R, -AXZ];
  const FAX = [0, R, AXZ];

  tube(group, BB, CROWN, 0.042, frameMat);                   // down tube, fat
  tube(group, CROWN, HEAD_HI, 0.038, frameMat);              // head tube
  /* The step-through curve, in two segments so it is a CURVE and not a
     diagonal. It is what makes the frame read as a rounded loop rather
     than a triangle of sticks, and it leaves the space in front of his
     belly empty so the RIDER is the silhouette. */
  tube(group, SEAT_HI, KNEE, 0.036, frameMat);
  tube(group, KNEE, [0, 0.600, 0.372], 0.036, frameMat);
  tube(group, BB, SEAT_HI, 0.040, frameMat);                 // seat tube
  for (const s of [-1, 1]) {
    tube(group, [CROWN[0] + s * 0.014, CROWN[1] + 0.020, CROWN[2] + 0.004],
      [FAX[0] + s * 0.050, FAX[1], FAX[2]], 0.026, frameMat);            // fork
    tube(group, [RAX[0] + s * 0.054, RAX[1], RAX[2]], SEAT_HI, 0.022, frameMat);  // seat stay
    tube(group, [RAX[0] + s * 0.054, RAX[1], RAX[2]], BB, 0.025, frameMat);       // chain stay
  }

  /* Mudguards — the single most Wind-Waker silhouette on the object,
     and the thing that stops the wheels reading as two bare rings. */
  {
    const g = new T.TorusGeometry(R + 0.026, 0.028, 5, 15, Math.PI * 0.78);
    owned.push(g);
    for (const s of [1, -1]) {
      const m = new T.Mesh(g, frameMat);
      m.position.set(0, R, s * AXZ);
      m.rotation.y = Math.PI / 2;
      /* The arc starts at +x of the torus's own plane, which after the
         y-rotation is +z (forward). Roll it back so the guard sits over
         the TOP of the wheel and trails behind it. */
      m.rotation.x = Math.PI * (s > 0 ? 0.16 : 0.38);
      group.add(m);
    }
  }

  /* ================================================================
     Bars, grips and the bell.
     ================================================================ */
  tube(group, HEAD_HI, BAR_C, 0.028, metalMat);              // stem
  for (const s of [-1, 1]) {
    /* The sweep, in two segments: straight out from the stem, then a
       bend back toward the rider. A single straight bar would put the
       grip 50 mm in front of the mitten and 80 mm outboard of it. */
    tube(group, BAR_C, [s * 0.205, BARS.y + 0.010, BARS.z + 0.046], 0.024, metalMat);
    tube(group, [s * 0.205, BARS.y + 0.010, BARS.z + 0.046],
      [s * (BARS.x - 0.010), BARS.y, BARS.z - 0.022], 0.024, metalMat);
    /* Rubber grips: fatter than the bar, so the mitten has something to
       close around and the bar end is never a flat disc. */
    const grip = new T.Mesh(capsuleGeo(0.040, 0.140), tyreMat);
    grip.position.set(s * (BARS.x - 0.020), BARS.y + 0.002, BARS.z + 0.004);
    grip.rotation.z = Math.PI / 2;
    grip.rotation.y = s * 0.22;
    group.add(grip);
  }
  {
    /* The bell. One small dome and the object stops being a bicycle in
       general and becomes his. */
    const g = new T.SphereGeometry(0.048, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.60);
    owned.push(g);
    const bell = new T.Mesh(g, frameMat);
    /* On the FAR bar from the drivetrain camera, so it never lands over
       his face in the side-on shot the cranks are photographed in.

       WHICH BAR THAT IS, stated properly, because the old note here had
       it backwards and a handedness error in the one file that
       publishes measured numbers is a trap. LEFT IS +X on this rig —
       rig.js puts legL0 at x +0.134, and bikeBody's inward knee roll
       drives legL toward -x, which is only "inward" if left is the
       positive side. The bell is at NEGATIVE x, so it is on his RIGHT
       bar, which is the far side from CAMS.bikeSide at x +3.25. */
    bell.position.set(-(BARS.x - 0.135), BARS.y + 0.026, BARS.z + 0.026);
    group.add(bell);
  }

  /* ================================================================
     Saddle — a rounded wedge, wide at the back, nosed forward.
     ================================================================ */
  {
    const g = new T.SphereGeometry(0.5, 14, 10);
    g.scale(0.108, 0.052, 0.190);
    /* Pull the nose in so it is a saddle and not an egg. */
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      if (z > 0) {
        const k = 1 - Math.min(z / 0.095, 1) * 0.62;
        p.setX(i, p.getX(i) * k);
      }
    }
    g.computeVertexNormals();
    owned.push(g);
    const saddle = new T.Mesh(g, woodMat);
    saddle.position.set(SADDLE.x, SADDLE.y - 0.018, SADDLE.z);
    saddle.rotation.x = -0.07;
    group.add(saddle);
    /* seat post — without it the saddle floats off the top of the
       seat tube, which is the first thing the eye finds */
    tube(group, [SADDLE.x, SADDLE.y - 0.100, SADDLE.z],
      [SADDLE.x, SADDLE.y - 0.026, SADDLE.z], 0.028, metalMat);
  }

  /* ================================================================
     Crank and pedals. The arms are 180 degrees apart so the two feet
     in `ride-bicycle` — which pedal in antiphase — land on them.
     ================================================================ */
  /* THE CHAINLINE IS WIDE ON PURPOSE. A real crank sits 75 mm off the
     centre-line; Wally's legs hang at x 0.134-0.150 because his thighs
     are as thick as his shins are long. Setting the arms at 0.075 puts
     the pedals 70 mm INBOARD of his feet, and from the side camera —
     the one that shows the drivetrain — that reads as feet hovering
     beside the pedals rather than on them. 0.108, with the pedal plate
     itself offset a further 0.028 outboard, lands the tread under the
     measured foot. It is a toy: the cranks are allowed to be as wide as
     the animal. */
  const crank = new T.Group();
  crank.position.set(BB[0], BB[1], BB[2]);
  tube(crank, [-0.100, 0, 0], [0.100, 0, 0], 0.028, metalMat);
  {
    const g = new T.TorusGeometry(0.086, 0.015, 5, 18);
    owned.push(g);
    const ring = new T.Mesh(g, metalMat);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = 0.112;
    crank.add(ring);
  }
  for (const s of [-1, 1]) {
    const arm = new T.Group();
    arm.position.set(s * 0.108, 0, 0);
    /* The two arms are 180 degrees apart, and the LEFT one is at
       rotation 0 because bikeBody() gives the left leg pedal phase 0,
       whose bottom-of-stroke is the crank hanging straight down. */
    arm.rotation.x = s > 0 ? 0 : Math.PI;
    tube(arm, [0, 0, 0], [0, -PEDAL.r, 0], 0.022, metalMat);
    const g = new T.BoxGeometry(0.070, 0.026, 0.112);
    owned.push(g);
    const pedal = new T.Mesh(g, woodMat);
    pedal.position.set(s * 0.028, -PEDAL.r - 0.014, 0);
    arm.add(pedal);
    crank.add(arm);
  }
  group.add(crank);

  /* ================================================================
     The front basket — the detail that makes it HIS bike and not a
     bike. A tapered open drum with a rolled rim: rounded, chunky, and
     it silhouettes as one shape instead of five thin panels.
     ================================================================ */
  {
    const basket = new T.Group();
    basket.position.set(0, 0.596, 0.468);
    const wall = new T.CylinderGeometry(0.148, 0.122, 0.198, 14, 1, true);
    const floor = new T.CylinderGeometry(0.122, 0.122, 0.022, 14);
    const rim = new T.TorusGeometry(0.148, 0.020, 5, 16);
    owned.push(wall, floor, rim);
    const w = new T.Mesh(wall, basketMat);
    /* An open drum has to show its inside too. A mirrored second copy
       is one extra draw of 28 triangles and keeps the shared material
       single-sided, which the outline hull pass needs. */
    const wm = new T.Mesh(wall, basketMat);
    wm.scale.set(-1, 1, 1);
    const f = new T.Mesh(floor, basketMat);
    f.position.y = -0.088;
    const r = new T.Mesh(rim, frameMat);
    r.position.y = 0.099;
    r.rotation.x = Math.PI / 2;
    basket.add(w, wm, f, r);
    basket.rotation.x = -0.10;
    group.add(basket);
    /* two chunky struts down to the fork crown, so it is CARRIED and
       not floating — the thing that reads wrong about every basket
       nobody bothered to hang */
    for (const s of [-1, 1]) {
      tube(group, [s * 0.096, 0.520, 0.472], [s * 0.024, 0.348, 0.392], 0.016, metalMat);
    }
    /* and a hanger back to the head tube */
    tube(group, [0, 0.660, 0.436], [0, 0.700, 0.348], 0.018, metalMat);
  }

  /* Kickstand — only visible when parked. A bike standing on two
     wheels with nothing under it reads as falling over.

     IT IS ON +X AND IT IS 30 MM LONGER THAN IT WAS, and both numbers
     are consequences of PARK_LEAN rather than taste. park() rolls the
     group by PARK_LEAN about z; a NEGATIVE z-roll tips the top toward
     +x, so the machine falls toward +x and the leg that catches it has
     to be on +x too. The old stand was at -x — the bicycle leant away
     from its own kickstand, which is only invisible if nobody ever
     looks at the parked pose, and nobody ever did (see wally.js: park
     was dead code).

     The FOOT height follows from the lean as well. The group rolls
     about its own origin, which is the ground line through both wheel
     contacts, so a foot at local (x, y) lands on the ground when
     x*sin(PARK_LEAN) + y*cos(PARK_LEAN) = 0, i.e. y = -x*tan(lean).
     At x 0.235 that is y 0.0307. A foot on y 0.006 — the old number —
     would have hung 25 mm in the air at this lean, or forced the lean
     down to 1.8 degrees, which is not a lean. */
  const PARK_LEAN = -0.13;
  /* THE FOOT, PUBLISHED, because the roll solve needs the point and
     guessing at geometry is how the last kickstand defect survived. It
     is the tube's far endpoint — the design contact point, on the
     contact plane at PARK_LEAN by the arithmetic above. */
  const PARK_FOOT = { x: 0.235, y: 0.031, z: -0.190 };
  const stand = tube(group, [0.048, 0.205, -0.085], [PARK_FOOT.x, PARK_FOOT.y, PARK_FOOT.z], 0.019, metalMat);
  /* NAMED, so a probe can ask whether a parked machine is actually
     standing on it without guessing at geometry. */
  stand.name = 'kickstand';
  stand.visible = false;

  if (ctx.mat.register) ctx.mat.register(group, { castShadow: true, receiveShadow: true });
  /* FRUSTUM CULLING IS ON. It used to be switched off across the whole
     prop, on the argument that "the group rides Wally's root and his
     bounding sphere already covers it, and a wheel that pops out at the
     frame edge is a worse defect than a draw call".

     Neither half of that survived measurement. Three.js culls a mesh
     only when its OWN bounding sphere is entirely outside the frustum,
     so a wheel half in shot is never culled and cannot pop; and Wally's
     bounding sphere covers nothing here, because the prop's meshes are
     tested individually and are not inside it in any case. What the
     flag actually bought was a machine that keeps drawing when it is
     behind the lens: a bicycle PARKED 12 m behind the camera measured
     199 draw calls and 30 751 rendered triangles a frame, and one 40 m
     behind measured 163 and 25 541. With the flag on, all that is left
     off screen is the shadow — 106 calls under 20 m, 53 out to 80 m,
     0 past 100 — and parkedCull() in wally.js takes even that to 0
     past 64 m. See the ladder in this file's header. */
  group.traverse((o) => { if (o.isMesh) o.frustumCulled = true; });

  /* ------------------------------------------------------------------
     THE WHEELS ARE DRIVEN BY DISTANCE, NEVER BY THE CRANK.

     A crank phase is a GEAR: it is metres of ground per pedal stroke,
     and it is allowed to change with the ladder rung — that is what a
     bicycle with gears does. A wheel is not allowed to change: it is
     tyre-bound to the road, exactly 1/(2*pi*R) revolutions per metre,
     at every rung, forever. Deriving one from the other made both of
     those the same number, so the wheels ran 18% slow at cruise and 41%
     slow at the sprint rung — and worse, they inherited the pedal
     phase's wrap, snapping backwards 302 degrees about 1.5 times a
     second.

     WHAT 302 DEGREES LOOKED LIKE, stated correctly. The five spokes are
     each a full DIAMETER — `sp.rotation.x = (i/5)*PI` lays them at 0,
     36, 72, 108 and 144 degrees and every one of them crosses the hub —
     so the wheel is invariant under a 36-degree turn: TEN-fold
     symmetry, not the five-fold this note used to claim. 302 mod 36 is
     14, so the snap the eye saw was 14 degrees backwards on either
     reading. The conclusion survived the error; the stated symmetry did
     not, and a wrong number in the one file that publishes measured
     numbers is a trap for whoever reads it next.

     Each wheel keeps its OWN angle and its OWN radius. Two wheels on
     one machine are not always the same size (the motorcycle's rear is
     8 mm fatter than its front) and sharing one accumulator makes one
     of them wrong by construction. `w.position.y` is the axle height,
     which for a wheel standing on the ground IS the rolling radius, so
     no module has to publish a second copy of the number.

     The per-wheel angle is wrapped into [0, 2*pi). That wrap is EXACTLY
     one turn, so it is invisible — which is the whole difference
     between it and the 1.84-turn wrap this replaces.
     ------------------------------------------------------------------ */
  const TAU = Math.PI * 2;
  const wheelR = wheels.map((w) => Math.max(w.position.y, 0.02));
  const wheelA = wheels.map(() => 0);
  let odo = 0;                 // metres of ground under the tyres

  const api = {
    group,
    SADDLE, BARS, PEDAL,
    wheels, crank, stand,
    R,
    /** Rolling radius of each wheel, in the order of `wheels`. */
    get wheelRadii() { return wheelR.slice(); },
    /** Metres of ground rolled since boot — the drivetrain's odometer. */
    get odometer() { return odo; },

    /**
     * Roll the wheels forward by `metres` of ground. The ONLY honest
     * drive: it is continuous (no wrap to snap on) and it is correct at
     * every rung of every ladder because it never reads a clip.
     *
     * A NEGATIVE VALUE ROLLS THEM BACKWARDS. That is API surface, not a
     * live path: the only in-game caller is wally.js's bikeUpdate,
     * which passes `speed * dt` off the controller's `planarSpeed` —
     * a magnitude, non-negative by construction — so nothing in the
     * shipped game can reach this branch today. It is kept correct
     * because reversing is the obvious next caller, and a drive that
     * silently refuses to go backwards is a worse surprise than one
     * that never had the option.
     * @param {number} metres
     * @returns {number} the odometer
     */
    roll(metres) {
      const d = Number.isFinite(metres) ? metres : 0;
      odo += d;
      if (!Number.isFinite(odo)) odo = 0;
      for (let i = 0; i < wheels.length; i++) {
        let a = wheelA[i] + d / wheelR[i];
        a -= Math.floor(a / TAU) * TAU;
        if (!Number.isFinite(a)) a = 0;
        wheelA[i] = a;
        wheels[i].rotation.x = a;
      }
      return odo;
    },

    /* THERE IS NO update(dt, speed) HERE ANY MORE, and its absence is
       part of the contract rather than a deletion. It rolled the wheels
       and then set the crank from the ODOMETER at a fixed 2.6 m/turn,
       and it described itself as the path "a caller that has no
       animator" would use. There was no such caller: wally.js always
       takes the crank branch, and src/intro adopted this same prop and
       drives it with roll() + setCrankPhase() like everything else. A
       second, differently-geared drive sitting unused next to the real
       one is exactly the shape of the bug that started all this — two
       drivetrains for one bicycle, quietly disagreeing. One drive: the
       wheels take metres, the crank takes a phase. */

    /** Drive the cranks straight from the animator's pedal phase so the
        pedal is always under the foot, whatever the blend is doing. */
    setCrankPhase(ph) {
      crank.rotation.x = ph;
    },

    /** Lean it on its stand, as a parked prop. See PARK_LEAN.
        `roll` overrides the lean when the caller has conformed it to
        the ground's cross-slope (solveParkPose); omitting it is the
        flat-ground pose and is what every other caller wants. */
    park(on = true, roll) {
      stand.visible = !!on;
      group.rotation.z = on ? (Number.isFinite(roll) ? roll : PARK_LEAN) : 0;
      if (on) crank.rotation.x = 1.15;
    },
    /** The roll a parked bicycle rests at, so the caller can blend to it. */
    get parkLean() { return PARK_LEAN; },
    /** The stand's design contact point, prop-local. See PARK_FOOT. */
    get standFoot() { return PARK_FOOT; },

    dispose() {
      group.parent?.remove(group);
      for (const g of owned) g.dispose();
      for (const m of mats) m.dispose?.();
      capCache.clear();
    },
  };

  return api;
}

export default createBike;
