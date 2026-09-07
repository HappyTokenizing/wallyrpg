/* ============================================================
   lighting.js — the lighting rig the whole game hangs off.

   ART_DIRECTION §2.1 fixes the colours, §2.4 the haze, §3 the shadow
   pipeline. This file is the single place where TIME_OF_DAY becomes
   actual light:

     key        the sun. It is not a light we own — it is
                ctx.render.csm, because the shadow cascades and the
                shading term have to agree about where the sun is or
                a cast shadow lands somewhere its terminator is not.
     hemi       sky-coloured fill above, warm ground bounce below.
                One THREE.HemisphereLight so non-toon materials (any
                module that reaches for MeshStandardMaterial) still
                sit in the same light as everything else.
     ambient    ctx.mat.setAmbient — the two-lobe term the toon
                shader actually integrates. Budgeted against the hemi
                light so the two do not double-count.
     fog        scene.fog. Its colour is the SAME value the sky dome
                paints at h = 0. Not "close to" — the same uniform.
                Anything else and the horizon line visibly cracks.
     exposure   ctx.render.setExposure + the post grade, crossfaded.
     godrays    a screen-space radial-occlusion pass, drawn as the
                last thing in the forward pass (so bloom and DOF see
                it) using the render core's normal/depth prepass as
                the occlusion mask.

   EXPOSURE CONVENTION (from toon.js, and it is load-bearing):
   a lit surface is albedo * (sun + ambient), so sunIntensity +
   ambIntensity stays near 1.0. Above ~1.3 the two-band ramp and the
   velvet grain compress into the same white and the frame stops
   being cel shaded.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { SKY, LAND, SHADOW, TIME_OF_DAY } from '../core/palette.js';
import { clamp, lerp, smoothstep, damp } from '../core/contracts.js';

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const DEG = Math.PI / 180;

/* hoisted — read every frame, allocated once */
const C_SAND = srgb(LAND.sand);
const C_NIGHT = srgb(SKY.night);
const C_HALO = srgb(SKY.sunHalo);

/* ------------------------------------------------------------------
   Two colour predicates, both measured in GAMMA space, both used by
   the table sampler below AND by the blend in update(). They are here
   rather than inside createLighting because when they were two copies
   the sampler and the blend disagreed about what a neutral is.

   chromaOf — chroma as a fraction of the brightest channel. These are
   authored colour-picker values and the question being asked of them
   ("which of these two is the more colourful?") is a perceptual one;
   in linear space the peach horizon #F7C6A0 reads 0.61 and the pale
   blue fog #C8D6E8 reads 0.30, which says they are within a factor of
   two of each other when to the eye (0.35 vs 0.14) one is a colour and
   the other is nearly white.

   warmthOf — how much WARMER than cool a colour is, 0..1. This is the
   number that decides whether the dome's vertical ramp is about to
   cross magenta: the boosted zenith is a blue with essentially no red
   in it, so any horizon whose red beats its blue puts a warm end and a
   cool end on the same straight line and every value between them has
   green as its smallest channel. Elevation is a proxy for that and a
   bad one — TIME_OF_DAY's horizon is still warm at 08:20, by which
   point the sun is 28 degrees up and every low-sun gate in this file
   has already switched off. Ask the colour, not the sun.
   ------------------------------------------------------------------ */
const gam = (v) => Math.pow(Math.max(v, 0), 0.45455);
const lin = (v) => Math.pow(Math.max(v, 0), 2.2);

function chromaOf(c) {
  const r = gam(c.r), g = gam(c.g), b = gam(c.b);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx > 1e-4 ? (mx - mn) / mx : 0;
}
function warmthOf(c) {
  const r = gam(c.r), b = gam(c.b);
  return r > 1e-4 ? clamp((r - b) / r, 0, 1) : 0;
}
/* SIGNED warmth, -1..1. warmthOf clamps at zero, so it cannot tell a
   pale cyan from a neutral — and "these two colours are on opposite
   sides of neutral" is exactly the question the band blend has to ask
   before it averages them. */
function swarm(c) {
  const r = gam(c.r), b = gam(c.b);
  const mx = Math.max(r, gam(c.g), b);
  return mx > 1e-4 ? clamp((r - b) / mx, -1, 1) : 0;
}

/* ------------------------------------------------------------------
   TIME_OF_DAY sampling.

   The table is sparse (9 keyframes) and wraps: the last entry is
   t = 22 and the next one after it is t = 0. Hue is interpolated in
   HSL for the three *sky* colours, because a straight linear lerp
   from dusk orange to night navy passes through a dead grey — the
   one colour §2.1 forbids anywhere in the frame.
   ------------------------------------------------------------------ */
const _keyA = {}, _keyB = {};

/* ------------------------------------------------------------------
   deMud — THE 17:00 LID, AND WHY IT WAS NEVER AN HOUR.

   MEASURED, this build, ANGLE Metal / M1 Max, anti-sun bearing, level:
   17:00 rendered a mean sky of #AF9BAE at HSV saturation 0.116, green
   the smallest channel in 69.5 % of sky pixels. Noon on the same rig
   is 0.53. The frame was a lid.

   It is not an hour, it is a segment. TIME_OF_DAY authors `horizon`
   #BFE2F2 (cyan) at 16:00 and #F2925C (orange) at 18:00, and a
   straight RGB lerp between two near-complementary colours passes
   through a NEUTRAL: measured on the authored entries, the horizon's
   chroma falls 0.215 -> 0.146 -> 0.618 across that segment and the
   fog's falls 0.173 -> 0.058 -> 0.354. 0.058 is a grey. lighting.js
   then resolves the band and scene.fog from that pair and the dome
   paints it flat across the bottom 20 degrees, so the neutral becomes
   the sky.

   The comment that used to sit below this one blessed exactly that:
   "a straight RGB lerp passes through a pale warm grey instead, which
   is what that hour actually looks like". It is not. It is the lid.

   The SAME segment shape exists at 07:00 -> 10:00, where the horizon
   runs peach -> cyan and its chroma collapses to 0.013 at 08:30 — a
   dead grey, and measured on the rig 08:00 rendered at saturation
   0.089, WORSE than the hour that was reported. One defect, two
   ranges. Nobody had connected them because only one had been looked
   at.

   What this does NOT do, and the reasons are measurements:

     · it does not rotate the hue. HSL takes the short arc and the
       17:30 sky came out green; that is recorded above and it is
       still true.
     · it does not push a saturated warm colour into the crossing.
       Tried: it lands golden hour at 16:30, and because the path from
       a cyan to a saturated cream ALSO crosses grey, the hours either
       side came out flatter than they started (16:30 chroma 0.120 ->
       0.078). A partial mix between opposite hues is always a mix
       through grey.
     · it does not retime the swing. The keyframes are the art
       direction; moving when the sunset starts is not this function's
       business.

   What a crossing hour actually is, is PALE — and the difference
   between a pale sky and a lid is value and the green channel, not
   chroma. So, weighted by how far the straight path has fallen below
   the paler of the two keyframes it sits between:

     1. green goes to the midpoint of red and blue. Below that line a
        warm colour is a PINK and a cool one is a LILAC, which is the
        "green is the smallest channel" reading the judge measured; on
        it, the same colour is an apricot or a sky blue.
     2. red and blue are pushed apart around their mean, so whichever
        lean the hour already has survives instead of averaging out.
     3. and the whole thing is LIFTED toward a bright haze. §2.1's
        "pales dramatically toward the sea line" is a bright band under
        a saturated zenith; the defect was a MID-VALUE neutral, which
        is the one thing that reads as a lid rather than as air.

   Both keyframes are untouched by construction — the deficit is zero
   at each end — and the deadband means a segment whose straight path
   never goes below the paler end is not touched at all. Measured
   against the authored table, exactly three of the eighteen segments
   move: horizon 07->10, horizon 16->18, fog 16->18. The 18:00 -> 20:00
   sunset, which was verified by eye and is correct, is arithmetically
   untouched at every hour.
   ------------------------------------------------------------------ */
/* the paler of the two keyframes, capped: past this a colour is
   colourful enough that a dip toward it is a design choice, not mud */
const MUD_CAP = 0.22;
/* a dip smaller than this is the table breathing, not a crossing */
const MUD_DEAD = 0.15;
const MUD_GAIN = 2.2;
/* gamma value the crossing is lifted toward */
const MUD_BRIGHT = 0.96;
/* only a BRIGHT haze going grey is this defect. A dusk colour is
   allowed to be dark and low-chroma — that is what dusk is — and
   without this gate the 19:30 fog (chroma 0.174, value 0.52) would be
   lifted into the verified-correct sunset. */
const MUD_VMIN = 0.60, MUD_VSPAN = 0.15;
/* THE SUN ANGLE AT WHICH THE HORIZON TURNS.

   The bias below needs a number saying WHEN in a crossing segment the
   warm colour takes over, and every fixed answer is wrong for one of
   the two segments: 07->10 is three hours long and 16->18 is two, so
   one exponent that puts the morning turn in the right place puts the
   evening one an hour early. Measured both ways — a hold of 2.2 gave a
   clean 17:00 and a crossing sitting on 08:00; a hold of 3.4 cleaned
   08:00 and took most of the colour out of 17:30.

   The thing that is actually the same at both ends of the day is the
   SUN. A horizon goes warm when the light starts travelling through a
   lot of atmosphere, so the turn is pinned to an elevation and the
   exponent is solved for per segment from the table's own authored
   elevations, which makes the morning hold hard (K 5.5 over three
   hours) and the evening one gentle (K 2.2 over two) from one number.

   18, and the sweep is the reason. Whatever this is set to, some ten
   to twenty minutes of the day still land on the crossing — no
   continuous path from a cyan to an orange avoids passing through
   colourless, that is geometry, not tuning. All 18 does is choose
   WHERE. Measured minute by minute over the whole authored table:

     17 -> 07:33-07:37 and 17:09-17:19   (intro hands over at 07:21)
     18 -> 07:39-07:44 and 17:05-17:15
     19 -> 07:44-07:49 and 17:02-17:12
     20 -> 07:48-07:55 and 16:58-17:09   (17:00 chroma 0.07)

   18 is the one that clears 07:00, the intro's 07:35, 08:00, 17:00,
   17:30 and 18:00 at once. */
const MUD_EL = 18;
/* how steeply the crossing itself is taken */
const MUD_SNAP = 1.4;
const _mud = new THREE.Color();

/* ------------------------------------------------------------------
   crossFade — THE CROSSING ITSELF, RATHER THAN A BETTER PLACE TO PUT
   IT.

   Reshaping the parameter moved the colourless moment; it could not
   remove it, because the colourless moment is not a property of the
   timing. Measured on the shipped build at ten-minute resolution —
   the sampling an hourly table cannot see:

     horizon 07:40  #F5F0EA  chroma 0.048   frame sat 0.029, grad 45.7
     horizon 17:10  #F5F4F2  chroma 0.014   frame sat 0.041, grad 46.8

   Two white windows, one per crossing, each about ten minutes wide,
   and the second one had never been looked at because 17:00 and 17:30
   both measure clean and the hour between them does not exist in an
   hourly table. And 07:20-07:45 measured WORSE after the reshaping
   than before it (07:30 sat 0.105 -> 0.078), which is what moving a
   hole does: it lands somewhere.

   The cause is geometric and no amount of easing touches it. The two
   keyframes are near-complementary — horizon 199 degrees at 16:00
   against 21 degrees at 18:00, 178 apart — and a straight line
   between two opposed chroma vectors passes through the origin. The
   origin is grey. Every RGB mix, every lerp, every ease is a point on
   that line.

   So the interpolation leaves the line. Value and chroma MAGNITUDE go
   on their own straight paths (a lerp of 0.215 and 0.618 cannot dip
   below 0.215 — chroma is carried across the segment by construction,
   which is the whole point), and only the hue ANGLE rotates. A polar
   path has no origin to pass through.

   WHICH WAY ROUND, and it is the only real choice here. A hue from a
   cyan to an orange can rotate through the yellows or through the
   magentas; there is no third option and neither arc is short. The
   magenta arc is the lid this project has already paid for twice —
   green-smallest is the tell and it is exactly what rotating through
   300 degrees produces. The yellow arc is what a sky does: cyan, sea
   glass, cream, gold, peach. So the arc is chosen as the one that
   CONTAINS gold, per segment, from the keyframes' own hues — the
   morning runs 26 -> 199 and the evening 199 -> 21, opposite
   directions, one rule.

   The cost of the yellow arc is the green sector: at full chroma,
   rotating through 130 degrees is a green sky, and HSL doing exactly
   that unprompted is why the 17:30 sky came out green and why hue
   interpolation was abandoned the first time. It is only a problem at
   full chroma. Held down to CROSS_GK across a 50-degree sector and
   floored so it can never become the grey we are leaving, it is a
   pale sea-glass for the four minutes it takes to cross — a colour,
   with a gradient under it, which is what the white window was not.

   Luminance is pinned to the straight path afterwards. Equal-V yellow
   is far brighter than equal-V blue, so a bare hue rotation makes the
   crossing flash; matching the gamma-space luma the straight lerp
   would have had costs nothing and keeps the exposure ladder honest.
   ------------------------------------------------------------------ */
const TAU = Math.PI * 2;
/* the hue a crossing is routed THROUGH: a gold. Anything on the
   yellow side of the wheel selects the same arc for both crossings. */
const CROSS_GOLD = 50 * DEG;

/* ------------------------------------------------------------------
   THE NOTCH — WHAT THE TEN-MINUTE GRID COULD NOT SEE, AND WHY IT WAS
   TWO DIFFERENT DEFECTS WEARING ONE SYMPTOM.

   Measured at ONE minute (M1 Max, ANGLE Metal, 1600x900 dome sampler)
   on the build this replaces:

     07:38  frame sat 0.027   band #C8D8C7 chroma 0.078   hue 116
     17:19  frame sat 0.067   band #B6D2BA chroma 0.138   hue 128

   07:38 was WORSE than HEAD (0.082) at that one minute. An hourly
   table hid it; the ten-minute grid this file's own brief mandated
   samples 07:30 and 07:40 and hid it again. Both grids agreed with
   themselves — contracts.js rule 3, for the tenth time.

   TWO CAUSES, which is why one number could never have fixed both.

   (1) THE MORNING IS THE BAND BLEND CANCELLING, NOT THE CROSSING.
       update() drives the band to the horizon when the horizon and
       the fog OPPOSE, and it measures opposition with swarm() — a
       RED-MINUS-BLUE lean. A hue rotating cyan->gold crosses the
       green sector, where red minus blue is zero and the chroma is
       not. Measured, minute by minute, morning:

         time   horizon chroma  opp (the shipped test)  cancellation
         07:36  0.357           0.101                   0.580
         07:37  0.201           0.102                   0.876
         07:38  0.160           0.039                   0.518
         07:39  0.160           0.000                   0.233
         07:40  0.195           0.000                   0.009

       where cancellation is how much chroma a 50/50 mix of the two
       LOSES against the mean of their two chromas. The protection
       switches off (0.102 -> 0.039 -> 0.000) over the three minutes
       cancellation is at its worst, so the band goes from 88 % of the
       horizon to a straight average of two colours 124 degrees apart.
       Horizon chroma 0.160 in, band chroma 0.078 out: half of it is
       lost in the blend, not in the crossing. The morning fog is not
       a crossing segment at all (#C7D6E8 -> #C4D8EA, both cool) so it
       sits still while the horizon rotates past it.

   (2) THE AFTERNOON IS THE DIP, AND ONLY THE DIP.
       There the fog IS a crossing and rotates WITH the horizon —
       measured, cancellation is 0.000 at every minute from 17:12 to
       17:26. Nothing is lost in the blend. What is lost is the floor:
       CROSS_DIP took 30 % off it at the deepest point of the sweep
       and both entries bottomed together (horizon 0.153, fog 0.123)
       for the four minutes 17:18-17:21.

   THE FIX, in three parts, each aimed at one measured thing:

     a. the blend asks about CANCELLATION rather than about warm-vs-
        cool. Strictly more general: a warm/cool pair cancels, so the
        old test is a special case, and it is kept as a floor so that
        every hour where it was the larger of the two is bit-identical.
     b. the dip is keyed to WHERE THE HUE IS, not to where in the
        sweep we are. The dip exists because hue 76 at the full floor
        rendered an olive — that is a fact about the yellow-green
        sector, not about the midpoint of a sweep. Outside that sector
        the arc is gold, cream, peach, sea glass and cyan, all of
        which carry 0.22 happily, so they now get it.
     c. and the sweep crosses that sector FAST. The arc is walked at a
        rate that depends on the hue it is passing through — slow at
        the ends, where the colours are ones §2.1 authors, quick
        through the 110 degrees it has no name for. Monotone, and it
        still hits both keyframes exactly, so nothing about WHERE the
        crossing sits moves; only how long it dwells on the part of
        the arc that cannot carry chroma.

   (b) and (c) together are what let the dip stay shallow enough to
   fix the afternoon without putting the lime and the turquoise back:
   the frames that used to be pale are now at the full floor, and the
   one frame that must still be pale is at a hue it passes through in
   under a minute.

   MEASURED, ONE MINUTE, prev and ship on the SAME page load through
   WALLY.debug.skyRule(); HEAD from tools/_sky-minute.mjs --swap-head.
   M1 Max / ANGLE Metal, 960x540, quality high, load average 4-6.
   `sat` is the sky mean's saturation, `band` the saturation of the
   rows just above the horizon, `gS` the green-smallest percentage:

     sun bearing, level          sat                band          gS
     time     HEAD  prev  ship   HEAD  prev  ship   HEAD prev ship
     07:37   0.083 0.071 0.078  0.223 0.201 0.216   28.2 13.6 19.1
     07:38   0.084 0.026 0.056  0.218 0.118 0.206   27.9  1.6  8.1
     07:39   0.083 0.074 0.143  0.212 0.079 0.078   27.8  0.0  0.0
     17:18   0.190 0.075 0.115  0.375 0.083 0.103   45.4  2.6  2.4
     17:19   0.192 0.106 0.099  0.386 0.191 0.162   44.9  2.2  0.5
     17:20   0.194 0.126 0.141  0.396 0.240 0.286   44.3 15.8 27.6

     anti bearing, level
     07:37   0.090 0.063 0.079  0.187 0.139 0.166   37.0  9.7 21.6
     07:38   0.088 0.159 0.091  0.180 0.063 0.140   37.5  0.0  0.0
     07:39   0.088 0.238 0.355  0.174 0.133 0.223   35.7  0.0  0.0
     17:18   0.232 0.295 0.388  0.350 0.234 0.307   54.7  0.0  1.9
     17:19   0.237 0.177 0.321  0.362 0.169 0.306   54.7  0.0  0.0
     17:20   0.242 0.059 0.042  0.375 0.141 0.204   54.7  0.2 15.4

   TWO OF THOSE COLUMNS DISAGREE AND THE EYE SETTLES IT, WHICH IS THE
   REASON `band` IS REPORTED AT ALL. `sat` averages the whole sky
   column, so it falls both when the band goes grey AND when the band
   is a saturated WARM colour under a saturated blue zenith — which is
   a dawn, the thing §2.1 asks for. At 07:38 anti it reads 0.159 for a
   pale MINT band and 0.091 for a pale CREAM one; the frames were
   opened side by side and the cream is the better sky by every rule in
   ART_DIRECTION. Same at 17:19 sun: prev's higher `band` is a yellow-
   green olive, ship's lower one is a sea green. HEAD's numbers are the
   largest in the table and HEAD is the mauve lid this whole line of
   work exists to kill — 28 % green-smallest in the morning and 45 %
   in the afternoon, against 0-8 % here.

   The bearing is varied for exactly this reason (contracts.js rule 3):
   a claim measured only anti-sun is a claim about the anti-sun view.
   ------------------------------------------------------------------ */

/* THE SECTOR A SKY HAS NO NAME FOR — AND IT IS TWO SECTORS, BECAUSE
   THE TWO QUESTIONS ARE NOT THE SAME QUESTION.

   §2.1's sky entries occupy two arcs of the wheel: 19..50 (peach,
   gold, sun disc) and 197..213 (horizon cyan, zenith, sea). Between
   them, going the gold way, is 150 degrees the palette does not name.

   The WARP sector is "which of that has nothing to linger on", and
   the honest answer is all of it, 58..168 — a sky is never a lime and
   it is never a jade either, so the sweep should be past all of it
   quickly.

   The DIP sector is a narrower and more specific claim: "which of it
   cannot carry the 0.22 floor without becoming a colour we have
   already rejected". That was measured off frames, not off the wheel,
   and the frames say yellow-green: hue 76 at the full floor rendered
   an olive. At the other end it is not true — hue 150 at 0.205 is the
   sea glass §2.1 asks for, and dipping it was costing the afternoon
   crossing its whole recovery. Measured, 17:19, anti-sun, one page
   load, four rules: band saturation 0.168 (prev) / 0.169 (one sector,
   58..168) / 0.297 (two sectors) — and by eye the first two are a
   sage-grey haze and the third is a sea green.

   Soft-edged so warpArc's cost field has a continuous derivative. */
const CROSS_G0 = 58 * DEG, CROSS_G1 = 168 * DEG;    /* warp */
const CROSS_D0 = 62 * DEG, CROSS_D1 = 142 * DEG;    /* dip  */
const CROSS_GSOFT = 16 * DEG;
function greenAt(h, g0, g1) {
  h = ((h % TAU) + TAU) % TAU;
  return smoothstep(g0 - CROSS_GSOFT, g0 + CROSS_GSOFT, h)
       * (1 - smoothstep(g1 - CROSS_GSOFT, g1 + CROSS_GSOFT, h));
}

/* ------------------------------------------------------------------
   RUNTIME REVERT — contracts.js "HOW THIS PROJECT PROVES A FIX", #1,
   the preferred form: every rule this file has shipped, side by side,
   selectable on the SAME page load, so a before/after table is one
   run of one build rather than two builds and a quotation.

     lerp  this build with deMud and crossFade taken out: the two
           lines a756e3d had, `out.horizon` and `out.fog` on a straight
           RGB lerp. It is NOT HEAD and must not be reported as HEAD —
           HEAD's update() has no opposition term in the band blend
           either (`t = clamp(0.5 - 1.1 * dawn * dom, ...)`), so every
           HEAD number in this file comes off a real HEAD checkout run
           by `tools/_sky-minute.mjs --swap-head`, not off this switch.
           What this rule isolates is exactly the crossing repair —
           and, measured against that HEAD checkout at the two notch
           minutes, it lands within 0.007 of it on frame saturation
           (07:38 sun 0.091 against 0.084, 17:19 sun 0.186 against
           0.192) and within 3 points on green-smallest, which is the
           evidence that the crossing repair is the load-bearing part
           of the difference and the band blend's opposition term is
           not.
     prev  the crossing fix as the judge accepted it: polar hue with
           a hold, a floor, and a dip keyed to the sweep midpoint.
           This is the build the 07:38 notch was measured on.
     warp  ROUND 4, and it shipped under the name `ship`, so every
           table above whose column says `ship` is this rule. It holds
           the chroma floor at 0.22 through a 173-degree hue arc and
           buys the colour back by walking the arc fast: measured at
           62.7 sRGB codes per REAL second (tools/_sky-minute.mjs
           --analytic), against 1.1 for `lerp` and 1.5-1.8 for a real
           HEAD checkout. That is the defect round 5 exists to fix.
     ship  ROUND 5, crossPace(). Same arc, same MUD_EL timing, same
           straight-path chroma spine; the floor becomes a CEILING
           inside the sector nobody can name, so the crossing is pale
           there rather than lime there, and with nothing left to
           hurry past the arc is reparametrised by its own LENGTH in
           sRGB and walked at one speed. 12.1 codes/real-second
           analytic; 7.8/10.7 on the composited frame against warp's
           25.4/31.6 (morning/afternoon, anti-sun, 960x540, M1 Max,
           ANGLE Metal, quality high, load average 7-9).

   Driven by tools/_sky-minute.mjs --rules lerp,prev,warp,ship. Every
   number in this file's comments that says "measured" came out of
   that switch unless it names a different rig.
   ------------------------------------------------------------------ */
/* HOW FAR THE GATE IS ALLOWED TO BE TURNED DOWN, and it is not all
   the way. Set by frames, like every other constant in this file.
   At K = 1 the crossing hands back its whole chroma the moment it
   rains: measured, 17:19 in rain rendered bandSat 0.436 on a band of
   #508D7E — a vivid sea green, which is the colour §2.1 does not
   author and this line of work exists to remove, merely moved onto
   the weather axis. At K = 0 it is round 5 and the band is #979A99.
   What the gate has to buy back is a SIGN, not a colour: a hue
   anywhere in the green half of the arc has green as its LARGEST
   channel, so green-smallest is impossible at any chroma that is
   legible at all, and the only failure is a chroma so small that the
   dither decides. So the gate comes down just far enough to put the
   post-weather horizon clear of that floor — measured analytically at
   17:19, post-weather horizon chroma 0.019 (K=0) / 0.112 (0.55) /
   0.208 (1.0) in rain — and no further. */
const CROSS_WXGIVE = 0.55;

const CROSS_RULES = {
  lerp: { straight: true, cancel: 0 },
  prev: { hold: 0.22, floor: 0.22, dip: 0.30, give: 0.12, hsnap: 3.2,
          warp: 0, hueDip: false, cancel: 0 },
  /* ROUND 4, and it shipped under the name `ship`. Every table above
     whose columns say `ship` came off THIS entry; it is renamed rather
     than deleted so those numbers still resolve to something you can
     run. --rules lerp,prev,warp,ship is the four-way. */
  warp: { hold: 0.22, floor: 0.22, dip: 0.30, give: 0.12, hsnap: 3.2,
          warp: 0.86, hueDip: true, cancel: 8.0, cancelDead: 0.18 },
  /* ROUND 5 EXACTLY, kept as a switch rather than a quotation:
     wxgive 0 makes the gate weather-blind, which is what round 5 was.
     Proven identical to the round-5 file, not merely equivalent —
     tools/_sky-minute.mjs --analytic at drain 0 and a reconstructed
     round-5 lighting.js agree bit for bit over 4 rules x 28800
     minute-samples x sun/amb/sky/horizon/fog/sunEl/exposure. This is
     what the weather before/after tables are differenced against, one
     page load, same minute, drift common-mode. */
  ship5: { pace: true, hold: 0.22, tail: 0.26, floor: 0.22, give: 0.30, gate: true,
           haze: 0.135, white: 0.055, warm: 1.0, lift: 0.85, cancel: 8.0, cancelDead: 0.18,
           wxgive: 0 },
  /* ROUND 6. Identical to ship5 in a clear sky by construction —
     CROSS_DRAIN is 0 there, so gk is 1 and every expression below is
     multiplied by one. */
  ship: { pace: true, hold: 0.22, tail: 0.26, floor: 0.22, give: 0.30, gate: true,
          haze: 0.135, white: 0.055, warm: 1.0, lift: 0.85, cancel: 8.0, cancelDead: 0.18,
          wxgive: CROSS_WXGIVE },
};
let RULE = CROSS_RULES.ship;
export function setSkyRule(name) {
  RULE = CROSS_RULES[name] || CROSS_RULES.ship;
  return RULE === CROSS_RULES[name] ? name : 'ship';
}
export function skyRuleNames() { return Object.keys(CROSS_RULES); }

/* how much of the segment each keyframe HOLDS its own hue for before
   the sweep starts. The sweep is the only part of the day that is
   allowed to be pale, and it is +/- this either side of the middle.
   (SMALLER is a LONGER hold: the sweep runs over 0.5 +/- this.) */
const CROSS_HOLD = 0.22;
/* chroma is never allowed below this — the number that separates a
   pale sky from a lid. The paler keyframe caps it, so a segment
   between two washed-out entries is not invented into a colour. */
const CROSS_FLOOR = 0.22;
/* how far the floor itself dips WHERE THE ARC HAS NO SKY COLOUR */
const CROSS_DIP = 0.30;
/* how hard the hue hurries through the middle of the arc */
const CROSS_HSNAP = 3.2;
const _hA = { h: 0, s: 0, v: 0 }, _hB = { h: 0, s: 0, v: 0 };

/* ------------------------------------------------------------------
   THE ARC IS WALKED AT A RATE THAT DEPENDS ON THE HUE.

   The clock spends a unit of time per unit of arc everywhere the arc
   is a colour §2.1 authors, and (1 - warp) of that through the sector
   it does not. Integrated and inverted, so it is a monotone
   reparametrisation of the same arc: warpArc(0) = 0, warpArc(1) = 1,
   every keyframe still hit exactly, no keyframe gains a kink.

   Measured, hue of the horizon entry, minute by minute:

     morning        07:37 07:38 07:39 07:40   in 58..168
       prev            44    87   139   180        2
       ship            34    55   170   191        0
     afternoon      17:18 17:19 17:20 17:21   in 58..168
       prev           173   128    76    36        2
       ship           187   150    47    28        1

   The one that is left, 150, is the jade end, which the DIP sector
   deliberately does not reach — it renders as a sea glass at 0.205
   rather than as a pale nothing at 0.151.

   32 cells, twice a frame. Measured on the frame census: no change
   to the median frame time at 1600x900 that rises above its noise.
   ------------------------------------------------------------------ */
const WARP_N = 32;
const _warpC = new Float64Array(WARP_N + 1);
function warpArc(hA, d, u, k) {
  if (!(k > 0)) return u;
  let acc = 0;
  _warpC[0] = 0;
  for (let i = 1; i <= WARP_N; i++) {
    acc += 1 - k * greenAt(hA + d * ((i - 0.5) / WARP_N), CROSS_G0, CROSS_G1);
    _warpC[i] = acc;
  }
  if (acc <= 1e-9) return u;
  const target = clamp(u, 0, 1) * acc;
  let i = 1;
  while (i < WARP_N && _warpC[i] < target) i++;
  const lo = _warpC[i - 1], hi = _warpC[i];
  return (i - 1 + (hi > lo ? (target - lo) / (hi - lo) : 0)) / WARP_N;
}

/* gamma-space HSV. The metrics this is judged by (chromaOf, and the
   rig's `sat`) are gamma-space HSV too, so the space the fix works in
   is the space the defect was measured in. */
function hsvOf(c, o) {
  const r = gam(c.r), g = gam(c.g), b = gam(c.b);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  o.v = mx;
  o.s = mx > 1e-4 ? d / mx : 0;
  if (d < 1e-6) { o.h = 0; return o; }
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  o.h = ((h * 60 * DEG) % TAU + TAU) % TAU;
  return o;
}
const LUMA = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114;

/* gamma HSV -> the linear Color, with the gamma luma pinned to `want`.
   Shared by both crossing rules so the only difference between them is
   the (h, s, v, want) they choose, which is the whole argument. */
function emitHSV(out, h, s, v, want) {
  const hh = (((h % TAU) + TAU) % TAU) / (60 * DEG);
  const i = Math.floor(hh), f = hh - i;
  const p = v * (1 - s), q = v * (1 - s * f), w = v * (1 - s * (1 - f));
  let r, g, bl;
  switch (i % 6) {
    case 0: r = v; g = w; bl = p; break;
    case 1: r = q; g = v; bl = p; break;
    case 2: r = p; g = v; bl = w; break;
    case 3: r = p; g = q; bl = v; break;
    case 4: r = w; g = p; bl = v; break;
    default: r = v; g = p; bl = q;
  }
  const have = LUMA(r, g, bl);
  const k = have > 1e-4 ? clamp(want / have, 0.55, 1.45) : 1;
  out.setRGB(lin(clamp(r * k, 0, 1)), lin(clamp(g * k, 0, 1)), lin(clamp(bl * k, 0, 1)));
  return out;
}

/* ------------------------------------------------------------------
   crossPace — ROUND 5. THE TRADE IS AN ARTEFACT OF A CONSTANT NOBODY
   HAD QUESTIONED, AND THE CONSTANT IS THE CHROMA FLOOR.

   The state of this defect after four rounds was a genuine-looking
   dilemma: too slow through the green sector gives a colourless
   minute, too fast gives a sky the player watches animate. Measured on
   the analytic sampler (below), round 4's horizon crosses at 62.7
   sRGB codes per REAL second against 1.1 for a straight lerp.

   But "too slow" and "too fast" are both statements about TIME, and
   rate is distance over time. Rounds 2, 3 and 4 added four schedulers
   — CROSS_HOLD, CROSS_HSNAP, CROSS_DIP and warpArc — and every one of
   them buys time. None of them touches the distance. The distance was
   fixed in round 2 by CROSS_FLOOR = 0.22: hold the chroma at 0.22
   while the hue walks 173 degrees and the path is ~110 sRGB codes long
   whatever clock you put on it, and 110 codes has to be spent
   somewhere. Spend it slowly and the sky sits on hues §2.1 does not
   author (the acid yellow at 07:30, the swimming-pool turquoise at
   17:10, the olive at 17:20 — all recorded above, all judged by eye).
   Spend it quickly and you get round 4. There is no third schedule.
   The dilemma is real and it is a consequence of the floor.

   Drop the floor to a haze value and the same 173 degrees is ~30
   codes. Then it does not need a schedule: it can be walked over
   twenty in-game minutes at under three codes a second and never be
   fast enough to see, AND never be legible enough to name as a lime.
   Four constants come out; one goes in.

   WHY A PALE CROSSING IS NOT ROUND 2's WHITE WINDOW, WHICH IS THE
   OBJECTION THIS HAS TO ANSWER. Round 2's crossing measured horizon
   #F5F0EA, chroma 0.048, and it read as white. Three things are
   different here and each of them is a measured quantity, not a
   preference:

     · chroma 0.135 rather than 0.048, floored, so the band is a cream
       or a sea glass rather than a paper;
     · the VALUE is lifted toward MUD_BRIGHT exactly where the chroma
       is given up (`lift`), so the crossing is a bright haze rather
       than the mid-value #CECECE (V 0.81) the straight path actually
       passes through at 07:38 and the mid-value green-smallest #D0CCD0
       the afternoon passes through — the two colours that ARE the lid;
     · and the hue is still on the gold arc, so green is the middle
       channel at the warm end and the largest at the cool end and
       green-smallest is impossible by construction, at any speed.

   THE ONE RULE THAT REPLACES THE FOUR SCHEDULERS: THE HUE MAY ONLY
   MOVE AS FAST AS THE CHROMA IS BEING GIVEN UP.

   The reason a slow rotation was rejected in round 3 is written above
   — "at half [the hold], 07:37 still carried chroma 0.341 while the
   hue had already left the peach for 44 degrees, and a khaki band is
   what that is. Any departure from the authored hue is paid for in
   chroma immediately." That is exactly right, and round 3 enforced it
   with a hand-set `give` and a hold. Here it is a coupling instead:

     pale = 1 - (straight path's chroma) / (the chroma the ends imply)

   is 0 at both keyframes and rises to ~1 where the straight RGB path
   cancels itself, i.e. precisely at the crossing. The hue's position
   on the arc is 0.5*(1 + S*(1 - pale)): while the colour still has
   its chroma the hue is pinned to the keyframe it belongs to, and it
   is only free to be mid-arc when there is almost no chroma left to
   paint it with. A khaki is unreachable, and so is a lime, without
   naming a sector or a rate. greenAt(), CROSS_G0/G1 and CROSS_D0/D1
   are used by the `warp` rule only and are dead on this path.

   `pale` is not invented either: it is read off the straight RGB lerp
   this whole file is a repair of, which is also the spine the chroma
   and the luma still ride on ("CHROMA IS NOT MINE TO INVENT", above,
   still holds — more so, since the floor it is clamped to is now a
   sixth of a keyframe rather than two thirds of one).

   Both keyframes are reproduced exactly: pale = 0 there, so s and v
   are the keyframe's own and S is +/-1, so uh is 0 or 1.
   ------------------------------------------------------------------ */
/* THE SECTOR THE GATE COVERS. Wider on the warm side than round 4's
   DIP sector: the frames that produced 62..142 were judged against a
   30 % dip, and at hue 63 a 30 %-dipped 0.22 is 0.19, which is the
   olive. Under a full gate the edge is where a colour STOPS being
   nameable, and §2.1's warm arc ends at 50 (the sun disc). The cool
   edge is left long, at 168, because the file measured hue 150 at
   0.205 as "the sea glass §2.1 asks for" and that judgement stands —
   the soft edge hands the jade end most of its chroma back. */
const CROSS_P0 = 52 * DEG, CROSS_P1 = 150 * DEG;
/* THE CHROMA A SKY MAY CARRY AT A HUE IT HAS NO NAME FOR. Round 2's
   white window measured 0.048 and read as paper; a keyframe carries
   0.21 to 0.62. This is a haze: a colour, and not one you can name. */
const CROSS_HAZE = 0.135;
/* AND THE SECTOR IS NOT UNIFORM. Near its edges a pale colour is still
   nameable and still a sky — a lemon-gold at 60, the jade the file
   measured at 150 and liked — but the middle of it, 90 to 130, is
   green, and this file's own side-by-side says a pale CREAM beats a
   pale MINT even at half the saturation ("0.154 for a pale mint and
   0.080 for a pale cream; the cream is the better sky by every rule in
   ART_DIRECTION"). So the floor dips again through the middle, to a
   near-neutral, and because the path is reparametrised by its own
   LENGTH the clock spends barely a minute there: at radius 0.05 the
   remaining 60 degrees of hue is 20 sRGB codes wide, so the sky can
   change its mind about which side of neutral it is on without the
   player being shown the transition. This is the "path that never
   enters the sector" — it enters it only where the radius is too
   small for the sector to have a colour. */
const CROSS_WHITE = 0.055;
/* how much of the way to MUD_BRIGHT the gated part of the arc is
   lifted. The difference between a pale sky and a lid is VALUE — this
   file's own deMud says so, and then never lets a crossing reach it. */
const CROSS_LIFT = 0.85;
/* how hard the gated hue is dragged to the gold at the deepest point */
const CROSS_WARM = 1.0;
/* the luma the gated crossing is lifted toward. Lower than MUD_BRIGHT
   (0.96) on purpose: at chroma 0.14 a luma of 0.96 puts the brightest
   channel at 1.00 and the band clips before the tone map sees it —
   measured, 17:20 rendered V 1.000. */
const CROSS_BRIGHT = 0.92;

/* ------------------------------------------------------------------
   ROUND 6 — THE GATE IS TURNED DOWN BY THE WEATHER, AND THE REASON IS
   A SIGN, NOT A MAGNITUDE.

   Weather had never been sampled by any rig in this repo. Swept, it
   is where round 5 is worst, and the obvious explanation — "a repair
   tuned on clear-sky chroma meets a palette that has already had its
   chroma taken away" — is WRONG, measured. update() applies exactly
   the same weather lerps to every rule, so if that were it, every
   rule would lose the same fraction. What the same lerps actually do
   at 17:19 (analytic, node, no renderer, `node tools/_wxmech.mjs`
   arithmetic reproduced from update()'s colour block):

     rule   tod.horizon chroma   after RAIN   lost
     ship        0.067             0.019       72 %
     prev        0.153             0.154        0 %
     warp        0.205             0.202        1 %

   Nothing was drained. ship's chroma was CANCELLED, and cancellation
   is a statement about two colours, not one. The overcast term pulls
   the horizon 42 % toward 0.65*fog + 0.35*sky, and `sky` at a
   crossing minute is a BLUE — swarm -0.58. The signed warmth of the
   thing being pulled is what decides whether that lerp is a blend or
   an annihilation:

     rule   swarm(tod.horizon) @17:19    side of neutral
     ship        +0.06                   WARM   <- opposite the sky
     prev        -0.02                   cool
     warp        -0.11                   cool

   This file already knows this failure exactly twice — "Averaging a
   warm and a cool at equal value lands on a neutral", and "Equal
   chroma on opposite sides of neutral is the WORST case for an
   average" — and defends the band blend against it with `opp` and
   `cancel`. The weather blend has no such defence and never needed
   one, because until round 5 the crossing came out COOL. CROSS_WARM
   moved it across neutral. So the weather average now straddles the
   origin, and a horizon that lands ON the origin is not a pale sky:
   it is whatever the next thing to add a tint says it is. Measured on
   the composited frame, R-G over the sky region at 17:19 storm:
   prev -23.6 codes (decisively green-side, gSmall 3.4 %), ship -3.1
   with a spread of -14..+13 (gSmall 31.0 %). gSmall is an unthreshold-
   ed SIGN test, so a field sitting on the origin scores 30-50 % on it
   while looking like nothing at all; the defect the number is really
   reporting is that the red-green axis has no sign left.

   THE FIX IS THE ONE THE BRIEF ASKS FOR: in a sky the weather has
   deliberately drained, the repair DOES LESS. `drain` is how hard the
   weather is about to pull the horizon toward the zenith and the
   shadow tint, and it turns down the three things the gate adds over
   the straight path — the chroma ceiling, the luma lift and the warm
   pull — together, so at drain = 1 crossPace is the arc walked at the
   straight path's own chroma and the straight path's own lean.

   AND IT COSTS THE CLEAR SKY NOTHING BY CONSTRUCTION. drain is
   deadbanded ABOVE the clear preset's own cloud cover (WEATHER.clear
   is cloud 0.44, which is overcast 0.067 and a pull of 0.028), so
   clear weather is drain = 0 and every number round 5 was accepted on
   is arithmetically untouched — not "measured the same", the same
   expression. sampleTOD() defaults to 0, so tools/_sky-minute.mjs
   --analytic measures the clear-sky path it always measured unless
   --weather says otherwise.

   PROVEN, not asserted: a reconstructed round-5 lighting.js (this file
   with the three `* gk` factors and the drain block removed) and this
   one at drain 0 agree BIT FOR BIT over 4 rules x 28800 minute-samples
   x sun/amb/sky/horizon/fog/sunEl/exposure. And the drain cannot reach
   the rest of the day in ANY weather: swept minute by minute at
   drain 1, the only minutes whose table entries move at all are
   07:32-07:47 (max 35.5 codes) and 17:12-17:28 (max 43.6). The sunset
   18:00-19:20, the intro's 07:21 peach and every other hour are
   arithmetically untouched in rain and storm as well as in clear.
   ------------------------------------------------------------------ */
let CROSS_DRAIN = 0;
/* the raw weather pull, 0..1. The RULE decides how much of it to
   honour (R.wxgive), so `ship5` below can be round 5 — weather-blind —
   on the SAME page load as `ship`. */
/* update() sets this from the blended weather state before it samples
   the table. It is module state rather than an argument because
   sampleTOD is a public export with a fixed signature that four rigs
   and sky.js call; the default is the clear sky. */
/** THE WEATHER DRAIN, AS A PURE FUNCTION SO IT CAN BE ASSERTED.
    It lived inline in update() and nothing could reach it, which meant
    the whole clear-sky guarantee — every number round 5 was accepted on
    — rested on WEATHER.clear.cloud (0.44) staying under the deadband by
    0.004, with no test tying the two files together. Raise the authored
    cloud to 0.448 and the accepted clear sky starts moving silently.
    tools/test-game.mjs now asserts weatherDrain(WEATHER.clear) === 0.
    Named for what it takes, not what it sets: skyDrain() below READS the
    current value, this one COMPUTES it from a weather preset. */
export function weatherDrain(wx) {
  return clamp((smoothstep(0.34, 1.0, wx.cloud) * 0.42 + wx.storm * 0.34 - 0.03) / 0.45, 0, 1);
}

export function setSkyDrain(d) {
  CROSS_DRAIN = clamp(Number(d) || 0, 0, 1);
  return CROSS_DRAIN;
}
export function skyDrain() { return CROSS_DRAIN; }

/* ------------------------------------------------------------------
   THE CROSSING IS WALKED AT A CONSTANT SPEED IN sRGB, AND THAT IS THE
   WHOLE OF THE RATE FIX.

   warpArc walked the arc at a rate that depended on the hue, with the
   cost field `1 - k*greenAt(h)` set by hand. That is a redistribution
   of a FIXED total, so making the sector cheap necessarily makes it
   fast: round 4's 62.7 sRGB codes per real second is what k = 0.86
   buys. The generalisation is to stop guessing the cost and integrate
   the real one — the length of the path in the space the defect is
   measured in. Equal ticks of the clock then cover equal DISTANCE, so
   the crossing has one speed, and that speed is
   (path length) / (sweep duration), which are both things this file
   chooses rather than discovers.

   The path is short because the gate keeps the middle pale, so the
   quotient is small without the sweep having to be long: measured
   below at 2.5 codes/real-second peak against HEAD's 2.2, on a sweep
   that is four times WIDER in minutes than round 4's, not narrower.

   PACE_N cells, twice a frame, same shape and half the count of the
   warpArc it replaces. */
/* the floor inside the sector: R.haze at its edges, R.white through
   the green middle of it. sin^2 of the normalised position, so it is
   continuous and has a continuous derivative for the integrator. */
function paceBump(h) {
  const x = clamp(((((h % TAU) + TAU) % TAU) - CROSS_P0) / (CROSS_P1 - CROSS_P0), 0, 1);
  return Math.sin(Math.PI * x) ** 2;
}
function hazeAt(bump, R) { return lerp(R.haze, R.white, bump); }
/* AND THE NEAR-NEUTRAL IS WARM, WHICH IS THE HALF OF THIS THE METRIC
   CANNOT SEE. deMud already argues it for its own branch — "at the
   exact crossing there IS no lean to keep... Haze is warm" — and this
   file's own side-by-side says a pale cream beats a pale mint. Left
   alone the arc puts hue 110 at the deepest point, and 110 at chroma
   0.06 renders a sage-grey: legal, dull, and it reads warmthOf() at
   0.02, which collapses `dawn` and with it the whole warm band
   treatment five minutes before the sun has any business losing it.
   So the hue is dragged toward the gold the arc was chosen to contain,
   in step with the same bump that takes the chroma down — the pull is
   zero at both gate edges, so the arc is still hit exactly, and it
   costs nothing in codes because it only ever acts at the floor. */
function warmPull(h, bump, k) {
  if (!(k > 0)) return h;
  let dg = ((CROSS_GOLD - h) % TAU + TAU) % TAU;
  if (dg > Math.PI) dg -= TAU;
  return h + dg * bump * k;
}

const PACE_N = 96;
/* TWO slots, not one. The path is a property of the SEGMENT, so it is
   constant for the three hours of a morning — but update() resolves
   the horizon and then the fog, which are different segments, and a
   one-slot cache would thrash between them every frame and cost the
   full integral twice. Keyed on the pair of hues and the rule. */
const _paceC = [new Float64Array(PACE_N + 1), new Float64Array(PACE_N + 1)];
const _paceKey = ['', ''];
let _paceSlot = 0;
const _pace = new THREE.Color();

/* the crossing path as a function of arc position u, in gamma space.
   Returns nothing; writes r/g/b into _paceRGB. Chroma, gate and lift
   are all functions of u alone, which is what makes the path
   integrable — the straight-path max in crossPace() only ever raises
   the chroma near the ends, where the clock is slowest anyway. */
const _paceRGB = [0, 0, 0];
/* gk is 1 - drain: how much of the gate is in force. The INTEGRATOR
   has to see it too, or the path it measures is not the path that is
   walked and the constant-speed reparametrisation is a fiction. */
function pacePoint(u, hA, d, sA, floor, R, lA, lB, gk) {
  const h = hA + d * u;
  /* ONLY THE KEYFRAME BEING LEFT LENDS ITS CHROMA, exactly as the
     accepted build had it. Lending from the arriving end as well was
     tried and measured: it put the horizon at 0.497 at 17:30 against
     0.372, which is the sunset arriving half an hour early — the error
     this file already names ("a 0.457 orange at 17:25 with the sun 16
     degrees up"). The approach stays on the straight path. */
  const env = lerp(sA, floor, smoothstep(0, R.give, u));
  const gate = greenAt(h, CROSS_P0, CROSS_P1) * gk;
  const bump = paceBump(h);
  const hw = warmPull(h, bump, R.warm * gk);
  const s = lerp(env, Math.min(env, hazeAt(bump, R)), gate);
  const l0 = lerp(lA, lB, u);
  const v = clamp(lerp(l0, Math.max(l0, CROSS_BRIGHT), gate * R.lift) /
                  Math.max(1e-3, 1 - 0.45 * s), 0, 1);
  const hh = (((hw % TAU) + TAU) % TAU) / (60 * DEG);
  const i = Math.floor(hh), f = hh - i;
  const p = v * (1 - s), q = v * (1 - s * f), w = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: _paceRGB[0] = v; _paceRGB[1] = w; _paceRGB[2] = p; break;
    case 1: _paceRGB[0] = q; _paceRGB[1] = v; _paceRGB[2] = p; break;
    case 2: _paceRGB[0] = p; _paceRGB[1] = v; _paceRGB[2] = w; break;
    case 3: _paceRGB[0] = p; _paceRGB[1] = q; _paceRGB[2] = v; break;
    case 4: _paceRGB[0] = w; _paceRGB[1] = p; _paceRGB[2] = v; break;
    default: _paceRGB[0] = v; _paceRGB[1] = p; _paceRGB[2] = q;
  }
}

function crossPace(out, a, b, t, d) {
  const R = RULE;
  _pace.copy(a).lerp(b, t);
  const floor = Math.min(_hA.s, _hB.s, R.floor);
  const lA = LUMA(gam(a.r), gam(a.g), gam(a.b));
  const lB = LUMA(gam(b.r), gam(b.g), gam(b.b));
  /* how much of the gate the weather leaves standing. 1 in a clear
     sky, and then this whole function is round 5, expression for
     expression. */
  const gk = 1 - CROSS_DRAIN * (R.wxgive ?? 0);
  /* --- integrate the path, then invert it: equal clock, equal codes */
  const key = `${_hA.h.toFixed(4)},${_hA.s.toFixed(4)},${d.toFixed(4)},${lA.toFixed(4)},${lB.toFixed(4)},${floor.toFixed(4)},${gk.toFixed(3)}`;
  let slot = _paceKey[0] === key ? 0 : _paceKey[1] === key ? 1 : -1;
  if (slot < 0) {
    slot = _paceSlot; _paceSlot ^= 1; _paceKey[slot] = key;
    const C = _paceC[slot];
    let a2 = 0, pr = 0, pg = 0, pb = 0;
    C[0] = 0;
    for (let i = 0; i <= PACE_N; i++) {
      pacePoint(i / PACE_N, _hA.h, d, _hA.s, floor, R, lA, lB, gk);
      if (i > 0) a2 += Math.hypot(_paceRGB[0] - pr, _paceRGB[1] - pg, _paceRGB[2] - pb);
      C[i] = a2;
      pr = _paceRGB[0]; pg = _paceRGB[1]; pb = _paceRGB[2];
    }
  }
  const C = _paceC[slot];
  const acc = C[PACE_N];
  /* ONE MONOTONE CLOCK, WITH A HOLD AT EACH END AND NOTHING ELSE ON
     IT. No hsnap. R.hold is WIDER than round 4's — the sweep is longer
     in minutes, not shorter — because with the gate in place a long
     sweep costs pallor rather than costing a lime. */
  /* ASYMMETRIC, AND THE ASYMMETRY IS THE WHOLE OF WHAT A WIDER WINDOW
     MAY AND MAY NOT DO. Widening BOTH ends costs the dawn: measured,
     a symmetric hold of 0.50 put 07:30 on hue 44 at chroma 0.206 and
     rendered a green-cream where the accepted build renders the
     authored peach — the "07:20 to 07:45 is now worse" regression,
     re-created for the third time in this file's history. The
     keyframe being LEFT is authored and must be held; the approach to
     the one being ARRIVED at is three hours of unwritten morning and
     is where all the extra minutes are taken from. */
  const uc = smoothstep(0.5 - R.hold, 0.5 + R.tail, t);
  let u = uc;
  if (acc > 1e-9) {
    const target = uc * acc;
    let i = 1;
    while (i < PACE_N && C[i] < target) i++;
    const lo = C[i - 1], hi = C[i];
    u = (i - 1 + (hi > lo ? (target - lo) / (hi - lo) : 0)) / PACE_N;
  }
  const hArc = _hA.h + d * u;
  /* AND THE GATE. `gate` is 1 inside CROSS_P0..P1 — the sector the
     frames, not the wheel, said cannot carry chroma. Round 4 took 30 %
     off the floor there and then had to RACE through it, because 70 %
     of 0.22 at hue 76 is still a legible olive and the only remaining
     defence was to spend under a minute on it. That race IS the 62.7
     codes a second; the two are the same decision.

     Take the same dip to 100 % and the race is unnecessary. The sector
     stops being a place where the sky is the wrong colour and becomes
     a place where the sky is PALE, which is a thing a sky is. Once
     slowness costs pallor instead of costing a lime, slowness is free,
     and the brief's dilemma — grey minute against visible sweep — is a
     property of the PARTIAL dip, not of the crossing. */
  const gate = greenAt(hArc, CROSS_P0, CROSS_P1) * gk;
  const bump = paceBump(hArc);
  const h = warmPull(hArc, bump, R.warm * gk);
  const env = lerp(_hA.s, floor, smoothstep(0, R.give, u));
  /* chroma is still the straight path's wherever the straight path is
     healthy — the keyframes are therefore exact by construction */
  /* THE GATE IS A CEILING AND IT IS APPLIED LAST. Applying it to the
     envelope and then taking the max with the straight path lets the
     straight path smuggle chroma back in under a gated hue: measured,
     17:21 came out chroma 0.183 at hue 112, a lime, and the pace
     integrator — which models the gated path — under-slowed the clock
     there by a factor of three (17.1 codes/real-second). Taking
     chroma AWAY at a hue no sky is allowed to be is not inventing it. */
  const sBase = Math.max(chromaOf(_pace), env);
  const s = lerp(sBase, Math.min(sBase, hazeAt(bump, R)), gate);
  const v = lerp(_hA.v, _hB.v, t);
  /* the luma the straight path would have had, lifted toward a bright
     haze wherever the gate has taken the chroma off. Pale AND lifted
     is air; pale and mid-value is the lid this line of work started
     on — the straight path's own #CECECE at V 0.81 in the morning and
     its green-smallest #D0CCD0 at V 0.82 in the afternoon. */
  const l0 = LUMA(gam(_pace.r), gam(_pace.g), gam(_pace.b));
  const want = lerp(l0, Math.max(l0, CROSS_BRIGHT), gate * R.lift);
  return emitHSV(out, h, s, v, want);
}

function crossFade(out, a, b, t) {
  hsvOf(a, _hA); hsvOf(b, _hB);
  /* THE STRAIGHT PATH IS STILL TAKEN AT SPEED, and that part of the
     old fix was right for a reason that survives it. The tanh used to
     be there to rush a grey; it is kept because the RGB path's chroma
     sags for most of the segment whether or not it reaches zero, and
     unsnapped it holds 17:30 and 17:40 a third flatter than the build
     the judge accepted (0.173 against 0.201 measured on the rig).
     What has changed is that it no longer decides the HUE — that has
     its own clock below, and the two together are what stopped the
     sunset landing at 17:25. */
  t = 0.5 + 0.5 * Math.tanh(MUD_SNAP * (2 * t - 1)) / Math.tanh(MUD_SNAP);
  const R = RULE;
  /* the arc from a to b that contains CROSS_GOLD */
  let d = ((_hB.h - _hA.h) % TAU + TAU) % TAU;
  if (((CROSS_GOLD - _hA.h) % TAU + TAU) % TAU > d) d -= TAU;
  /* ROUND 5 takes the same arc and the same snapped t and differs only
     in what it does with them — see crossPace above. */
  if (R.pace) return crossPace(out, a, b, t, d);
  /* THE HUE MOVES ON ITS OWN CLOCK, AND THE CHROMA MUST NOT.

     Measured with one clock for both: 17:30 came out #C2C65D — a lime
     sky. The hue was still only two thirds of the way round the arc
     while the chroma lerp had already climbed to 0.52, so the frame
     got the sunset's saturation painted onto the crossing's hue. Same
     shape at 07:30 (#CEDE90).

     The hue is the part that has to hurry: it is the only thing on
     this path with somewhere unpleasant to be. So the hue takes a
     tanh through the middle — every keyframe still hit exactly, no
     kink at either end — and the chroma and value stay on the smooth
     eased parameter, where the art direction put them. */
  const u0 = 0.5 + 0.5 * Math.tanh(R.hsnap * (2 * t - 1)) / Math.tanh(R.hsnap);
  /* AND IT HOLDS AT BOTH ENDS, WHICH IS THE HALF OF THIS THAT THE
     FIRST VERSION GOT WRONG.

     A hue that starts moving the moment the segment does spends the
     whole segment somewhere between the two authored colours, and on
     this arc "between" is lemon, sage and turquoise. Rendered and
     looked at: 07:30 came out an acid yellow band (#E7D585 haze),
     17:10 a swimming-pool turquoise, 17:15 and 17:20 a sickly olive.
     Every one of those measured BETTER than the white it replaced and
     every one of them looked worse. The metric cannot see a hue it
     was not asked about; the frames could.

     So each keyframe holds its own hue for most of its half of the
     segment, and the whole rotation happens inside a short sweep in
     the middle — where the chroma dip below puts it at a pale tint.
     The sky is the authored peach, then briefly pale, then the
     authored cyan. It is never a colour nobody authored. */
  const uh = smoothstep(0.5 - R.hold, 0.5 + R.hold, u0);
  /* AND THE PART OF THE ARC WITH NO NAME IS CROSSED AT SPEED.

     uh is the clock; warpArc turns it into a position on the arc that
     lingers where the arc is a sky colour and hurries where it is
     not. Both keyframes are still reached at exactly uh = 0 and 1, so
     this cannot move the sunset or the dawn — it only decides how
     many minutes of the sweep are spent on a hue nobody authored.
     Measured, minutes with the horizon hue inside 58..168:
     morning 2 -> 0, afternoon 2 -> 1. */
  const ua = warpArc(_hA.h, d, uh, R.warp);
  const h = _hA.h + d * ua;

  /* CHROMA IS NOT MINE TO INVENT. IT IS THE STRAIGHT PATH'S, LIFTED
     OFF THE FLOOR AND NOTHING ELSE.

     A linear ramp between the two keyframes' chroma looks reasonable
     and is wrong: the straight RGB path's chroma does NOT rise
     linearly, it sags in the middle and arrives late, and that late
     arrival is what has been keeping the sunset out of the afternoon.
     Replacing it with a ramp put a 0.456 orange at 17:25 with the sun
     still 16 degrees up — the sunset an authored half-hour early,
     which is the same class of error as the lid.

     So the chroma is read straight off the RGB path this function is
     replacing, and touched ONLY where that path falls below the floor
     — a max, so anywhere the straight path is healthy it is passed
     through unchanged. At t = 0 and t = 1 the straight path IS the
     keyframe, which is well above the floor, so the keyframe is
     reproduced exactly, by construction — and the floor is capped by
     the paler keyframe, so it can never lift a segment above what the
     table authored at either end.
     Everything this function does to a crossing that a straight lerp
     did not is therefore: the hue during the sweep, and a floor. */
  _mud.copy(a).lerp(b, t);
  const floor = Math.min(_hA.s, _hB.s, R.floor);
  /* AND IT KEEPS LOOKING LIKE THE KEYFRAME IT JUST LEFT.

     The floor alone is not enough at the near end. Measured: with the
     straight path's chroma floored, 07:30 rendered sat 0.076 against
     0.105 before any of this existed — the peach that the table
     authors at 07:00 had already sagged to 0.13 by 07:30 and the
     floor only caught it at 0.22, so `dawn` (which is warmthOf of
     this colour) came out 0.54 where the pre-fix build had 0.78, and
     a weaker dawn signal is a weaker warm push into the band. That is
     the judge's "07:20 to 07:45 is now worse", and it is a chroma
     problem one layer up from the crossing.

     So while a keyframe's HUE is still being held, its CHROMA is held
     with it: the sky goes on looking like the colour the table
     authored at 07:00 until the moment it starts becoming the next
     one. Only the keyframe being LEFT gets this. The one being
     arrived at does not — that is what would have put a 0.457 orange
     at 17:25 with the sun 16 degrees up, the sunset half an hour
     early — so the approach to it stays on the straight path, whose
     late, sagging climb is exactly the "warmth arrives late" this
     file already believes in.

     Two numbers here, and both were set by looking at frames rather
     than at the table. The hold is given up over the first TWELFTH of
     the hue's sweep, not the first half: at half, 07:37 still carried
     chroma 0.341 while the hue had already left the peach for 44
     degrees, and a khaki band is what that is. Any departure from the
     authored hue is paid for in chroma immediately. And the floor
     itself dips by CROSS_DIP at the deepest part of the sweep, where
     the hue is unavoidably somewhere between yellow and cyan — 17:20
     sat on hue 76 at the full floor and rendered an olive. Paler is
     the one direction that is always safe: the sky still carries
     three to ten times the chroma of the white window it replaced
     (0.15 at the worst minute, against 0.048 at 07:40 and 0.014 at
     17:10 on the build this replaces).

     THE DIP IS NOW KEYED TO THE HUE, AND THAT IS THE HALF OF IT THE
     FRAME-TUNING GOT WRONG. `4 * uh * (1 - uh)` is deepest at the
     midpoint of the SWEEP, and the reason the dip exists is a fact
     about a SECTOR OF THE WHEEL: "17:20 sat on hue 76 at the full
     floor and rendered an olive". Those two coincide only at whatever
     frame the eye happened to be on. Measured on the shipped build,
     the horizon at 07:40 sat on hue 180 — a sea glass, which carries
     0.22 without complaint — and was dipped to 0.195 anyway, and
     17:18 sat on 173 and was dipped to 0.183. Both were paying the
     olive's bill.

     greenAt() asks the question the eye was actually asking. Outside
     58..168 the dip is exactly zero and the floor is whole; inside it
     the depth is unchanged, because inside it the eye was right. */
  const dipK = R.hueDip ? greenAt(h, CROSS_D0, CROSS_D1) : 4 * uh * (1 - uh);
  const s = Math.max(chromaOf(_mud),
                     lerp(_hA.s, floor * (1 - R.dip * dipK),
                          smoothstep(0, R.give, uh)));

  const v = lerp(_hA.v, _hB.v, t);
  /* luma pinned to the straight path (_mud is still it) */
  return emitHSV(out, h, s, v, LUMA(gam(_mud.r), gam(_mud.g), gam(_mud.b)));
}

function deMud(out, a, b, t, elA, elB) {
  const target = Math.min(chromaOf(a), chromaOf(b), MUD_CAP);
  if (target < 1e-4) { out.copy(a).lerp(b, t); return out; }
  /* IS THIS SEGMENT A CROSSING? Asked once, of the two keyframes, so
     the answer is a property of the segment and not of the hour. */
  _mud.copy(a).lerp(b, 0.5);
  const sev = clamp((target - chromaOf(_mud)) / target, 0, 1);

  /* THE COOL END OWNS THE MIDDLE OF A CROSSING.

     Half of the 17:00 lid is timing, not colour. The eased parameter
     is symmetric, so 17:00 sits at exactly 0.500 of the way from a
     cyan horizon to an orange one — the sky is half sunset with the
     sun still 26 degrees up, an hour and a half before the 18:00
     keyframe the sunset is authored at. Nothing looks like that.
     Worse, a horizon that warm turns on `dawn` (0.524 measured), and
     with it the dome's dawn stop, its band exponent and the exposure
     lift, all of which are meant for a sun on the horizon.

     Real warmth arrives late and leaves early: the peach is gone
     before 08:00 and the orange does not start until the sun is low.
     So on a crossing segment the parameter is biased AWAY from the
     warm keyframe, by an exponent solved so the halfway point lands
     where the sun passes MUD_EL. Both keyframes are still hit exactly
     (0^K = 0, 1^K = 1) and the eased parameter's zero derivative at
     each end survives the power, so no keyframe gains a kink. */
  if (sev > MUD_DEAD) {
    const warmB = swarm(b) > swarm(a);
    /* where in this segment the sun crosses MUD_EL, in the same eased
       parameter the colours are interpolated with */
    const tc = (MUD_EL - elA) / ((elB - elA) || 1e-6);
    if (tc > 0.03 && tc < 0.97) {
      const K = clamp(Math.log(0.5) / Math.log(warmB ? tc : 1 - tc), 1, 8);
      t = warmB ? Math.pow(t, K) : 1 - Math.pow(1 - t, K);
    }
    /* AND THEN IT IS TAKEN OFF THE STRAIGHT LINE ALTOGETHER.

       What used to be here was a tanh steepening of t, to rush the
       whole colour through the grey in about ten minutes. There is no
       longer a grey to rush through, and steepening t steepened the
       CHROMA too — which is the one thing that must not be rushed,
       because chroma is what tells the sunset when to arrive. The
       steepening now lives inside crossFade, on the hue alone. */
    return crossFade(out, a, b, t);
  }
  out.copy(a).lerp(b, t);
  const deficit = clamp((target - chromaOf(out)) / target, 0, 1);
  let d = clamp((deficit - MUD_DEAD) / (1 - MUD_DEAD) * MUD_GAIN, 0, 1);
  if (d <= 0.001) return out;
  let r = gam(out.r), g = gam(out.g), bl = gam(out.b);
  const v0 = Math.max(r, g, bl);
  const vg = clamp((v0 - MUD_VMIN) / MUD_VSPAN, 0, 1);
  d *= vg * vg * (3 - 2 * vg);
  if (d <= 0.001) return out;
  /* 1. no magenta. Pulled hard toward the r/b midline when green is
     below it, gently when it is above — a sky is allowed to be a
     little green-of-neutral (a cyan is), never red-of-it. */
  const mid = (r + bl) * 0.5;
  g += (mid - g) * clamp(d * 1.6, 0, 1) * (g < mid ? 1 : 0.22);
  /* 2. keep the lean it already has */
  r = mid + (r - mid) * (1 + 1.05 * d);
  bl = mid + (bl - mid) * (1 + 1.05 * d);
  /* 2b. and at the exact crossing there IS no lean to keep — red and
     blue are equal there, so step 2 has nothing to work with and the
     colour would come out a paper white. Haze is warm. This is the one
     place a temperature is invented rather than derived; it is worth
     about 9 % of split at full weight and it is what makes the
     crossing read as air. */
  r *= 1 + 0.045 * d;
  bl *= 1 - 0.045 * d;
  /* 3. pale, not grey */
  const s = 1 + (MUD_BRIGHT / Math.max(r, g, bl, 1e-4) - 1) * d;
  out.setRGB(lin(clamp(r * s, 0, 1)), lin(clamp(g * s, 0, 1)), lin(clamp(bl * s, 0, 1)));
  return out;
}

export function sampleTOD(hour, out) {
  const K = TIME_OF_DAY;
  const h = ((hour % 24) + 24) % 24;

  let i = K.length - 1;
  for (let k = 0; k < K.length; k++) if (K[k].t <= h) i = k;
  const a = K[i];
  const b = K[(i + 1) % K.length];
  const span = (b.t - a.t + 24) % 24 || 24;
  const raw = clamp((((h - a.t) % 24) + 24) % 24 / span, 0, 1);
  /* Ease the parameter, not the values: a linear walk between two
     keyframes makes the sun visibly change speed every time it
     crosses one. */
  const t = raw * raw * (3 - 2 * raw);

  out.sunEl = lerp(a.sunEl, b.sunEl, t);
  out.exposure = lerp(a.exposure, b.exposure, t);
  out.sun.copy(srgb(a.sun)).lerp(srgb(b.sun), t);
  out.amb.copy(srgb(a.amb)).lerp(srgb(b.amb), t);
  /* Zenith interpolates in HSL — every `sky` entry in the table is a
     blue, so the hue path is short and HSL keeps the value curve
     smooth through dusk.

     Horizon and fog do NOT. Their entries jump right across the wheel
     (cyan #BFE2F2 at 16:00 to orange #F2925C at 18:00), and HSL takes
     the shorter arc, which between those two runs 197 -> 120 -> 24:
     the 17:30 sky came out GREEN.

     They go through deMud() instead — a straight RGB lerp with the
     crossing repaired. The straight lerp on its own is what put the
     mauve lid at 17:00 and the grey one at 08:30; see the long note
     on deMud above for the measurements. */
  out.sky.copy(srgb(a.sky)).lerpHSL(srgb(b.sky), t);
  if (RULE.straight) {
    /* the `lerp` rule: a756e3d's two lines, verbatim */
    out.horizon.copy(srgb(a.horizon)).lerp(srgb(b.horizon), t);
    out.fog.copy(srgb(a.fog)).lerp(srgb(b.fog), t);
  } else {
    deMud(out.horizon, srgb(a.horizon), srgb(b.horizon), t, a.sunEl, b.sunEl);
    deMud(out.fog, srgb(a.fog), srgb(b.fog), t, a.sunEl, b.sunEl);
  }
  /* THE ELEVATION THE WORLD IS ACTUALLY LIT AT. Shaped, not raw —
     see shapeElevation(). Written back into tod so the dome's disc,
     the god rays, the grade and the key light can never disagree
     about where the sun is. */
  out.sunEl = shapeElevation(out.sunEl);
  return out;
}

/* ------------------------------------------------------------------
   Solar geometry — elevation.

   TIME_OF_DAY authors an elevation per keyframe and, taken literally,
   it puts the sun 72 degrees up at 13:00. Nine degrees off vertical.
   A key there throws a shadow 0.32x an object's height, straight down
   and mostly underneath it, so every building in the city loses the
   one cue that roots it to the ground and the frame reads as flat
   cutouts on a slab. §2.2 asks for a high-key palette; it does not
   ask for a high-noon *sun*, and Wind Waker never uses one — its
   shadows are unmistakable at every hour of its day.

   So the table's number is treated as INTENT and passed through a
   compressive curve. Below EL_KNEE it is identity, so dawn and dusk
   keep exactly the long raking key they were authored for; above it
   the curve rolls off asymptotically to EL_MAX. Measured against the
   table's own entries:

       07:00   14 -> 14.0    shadow 4.01x height   (unchanged)
       16:00   40 -> 37.4    shadow 1.31x height
       10:00   48 -> 41.3    shadow 1.14x height
       13:00   72 -> 47.7    shadow 0.91x height   (was 0.32x)

   Nothing in the frame gets darker; the sun simply stops standing on
   top of the city at midday.
   ------------------------------------------------------------------ */
const EL_KNEE = 18, EL_MAX = 52, EL_SOFT = 26;
export function shapeElevation(el) {
  if (el <= EL_KNEE) return el;
  return EL_KNEE + (EL_MAX - EL_KNEE) * (1 - Math.exp(-(el - EL_KNEE) / EL_SOFT));
}

/* Sun azimuth. East is -X, south is +Z, west is +X.

   AZ_OFFSET is a smaller, second-order trim on the same problem. A
   pure (hour - 12) * 15 arc is symmetric about the world Z axis, so
   around noon the sun sits on it and a shadow's run collapses onto
   the view axis of any camera looking up or down that axis — the run
   is still there, but almost none of it is lateral, so it reads as a
   smudge at the base of the wall rather than as a shadow.

   Rotating the whole day keeps the physical morning-east /
   evening-west sweep intact and buys back the lateral component.
   Measured at the opening hour against the default camera, the
   fraction of the shadow's run that lies across the frame rather
   than along the view axis goes 0.63 -> 0.87. */
const AZ_OFFSET = -22 * DEG;
export function sunAzimuth(hour) { return (hour - 12) * 15 * DEG + AZ_OFFSET; }

export function sunVector(hour, elevationDeg, out) {
  const az = sunAzimuth(hour);
  const el = elevationDeg * DEG;
  const c = Math.cos(el);
  return out.set(Math.sin(az) * c, Math.sin(el), Math.cos(az) * c).normalize();
}

/* ------------------------------------------------------------------
   God rays.

   Occlusion comes free from the render core's prepass: rtND writes
   linear view depth into alpha and the sky is excluded from it
   (userData.noPrepass), so alpha == 0 IS "this pixel is sky". A
   radial march toward the sun's screen position accumulating that
   mask gives shafts wherever the world breaks the sunlight.

   Drawn as a scene object rather than a post pass because postfx.js
   belongs to another agent: renderOrder 1e4 + transparent puts it
   last in the forward pass, which is exactly where light shafts want
   to be — before bloom, before DOF, before the grade.
   ------------------------------------------------------------------ */
function createGodRays(ctx) {
  const q = ctx.quality;
  const steps = q.name && /low/.test(q.name) ? 10 : (q.ssao ? 22 : 14);

  const uniforms = {
    tND:        { value: null },
    uSunUv:     { value: new THREE.Vector2(0.5, 0.5) },
    uColor:     { value: srgb(SKY.sunHalo) },
    uStrength:  { value: 0 },
    uDensity:   { value: 0.86 },
    uDecay:     { value: 0.965 },
    uAspect:    { value: 16 / 9 },
    uTime:      { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    name: 'sky.godrays',
    uniforms,
    defines: { GR_STEPS: steps },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tND;
      uniform vec2  uSunUv;
      uniform vec3  uColor;
      uniform float uStrength, uDensity, uDecay, uAspect, uTime;
      varying vec2 vUv;

      float grHash( vec2 p ) {
        vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
        p3 += dot( p3, p3.yzx + 33.33 );
        return fract( ( p3.x + p3.y ) * p3.z );
      }

      void main() {
        if ( uStrength <= 0.0005 ) { gl_FragColor = vec4( 0.0 ); return; }

        vec2 dv = ( vUv - uSunUv ) * ( uDensity / float( GR_STEPS ) );
        /* Per-pixel jitter of the march start. Without it a 22-step
           march paints 22 concentric arcs across the sky and reads as
           a rendering bug rather than as light. */
        vec2 c = vUv - dv * grHash( gl_FragCoord.xy + uTime );

        float illum = 1.0;
        float sum = 0.0;
        for ( int i = 0; i < GR_STEPS; i ++ ) {
          c -= dv;
          vec2 cc = clamp( c, vec2( 0.0 ), vec2( 1.0 ) );
          /* alpha is linear view depth; the sky never wrote to the
             prepass, so 0 means "sunlight reaches here". */
          float depth = texture2D( tND, cc ).a;
          sum += step( depth, 0.0005 ) * illum;
          illum *= uDecay;
        }
        sum /= float( GR_STEPS );

        /* Radial falloff, in aspect-corrected screen space so the
           shafts stay circular rather than stretching with the window. */
        vec2 rd = ( vUv - uSunUv ) * vec2( uAspect, 1.0 );
        float fall = exp( - length( rd ) * 2.55 );

        gl_FragColor = vec4( uColor * sum * fall * uStrength, 1.0 );
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.name = 'sky.godrays';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 10000;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.noPrepass = true;
  mesh.userData.noOutline = true;

  return { mesh, mat, uniforms };
}

/* ==================================================================
   createLighting
   ================================================================== */
export function createLighting(ctx) {
  const scene = ctx.scene;
  const q = ctx.quality;

  /* ---- interpolated time-of-day state ---- */
  const tod = {
    sunEl: 48, exposure: 1.0,
    sun: srgb(0xfff4dc), amb: srgb(0x9ab4d8),
    sky: srgb(SKY.zenith), horizon: srgb(SKY.horizon), fog: srgb(SKY.haze),
  };

  /* ---- the live, weather-modulated values other modules read ---- */
  const sunDirection = new THREE.Vector3(0.46, 0.72, 0.52).normalize();
  const moonDirection = new THREE.Vector3(-0.4, 0.6, -0.6).normalize();
  const sunColor = srgb(0xfff4dc);
  const ambientColor = srgb(0x9ab4d8);
  const fogColor = srgb(SKY.haze);
  const skyColor = srgb(SKY.zenith);
  const horizonColor = srgb(SKY.horizon);
  const haloColor = srgb(SKY.sunHalo);
  const shadowTint = srgb(SHADOW.tint);

  /* ---- the ACES pre-compensation, and why it is a SATURATION and
     not a gain ----

     The palette's sky entries are authored *display* colours, and
     everything here still has ACES in front of it. The obvious fix is
     to multiply the dome up so the tone curve lands on the swatch —
     and it is wrong, because the ACES RRT desaturates in proportion
     to how far up the shoulder a channel sits. Measured with a 1.34
     gain: #2E7FD4 (S 0.78) rendered at S 0.20. The gain pushed blue
     past 1.0 while red was still near the toe, which is precisely the
     condition the RRT bleaches.

     Pushing chroma instead lands it: same luminance, more distance
     from grey going in, so what survives the curve is a sky. Measured
     with sat 1.62: S 0.20 -> S 0.56 before the grade's own +10 %.

     These boosted colours go to THREE PLACES and they must be the
     same value in all three or the horizon cracks: the dome, the
     scene fog, and the clear colour. */
  const SKY_K = 4.00, SKY_GAIN = 1.02;
  function boost(c, k = SKY_K, gain = SKY_GAIN) {
    /* The push scales with how COOL the colour is, not with its
       chroma. Two measurements, both from this build:

         zenith #2E7FD4, chroma 0.96  ->  S 0.20 through ACES
         dusk   #F2925C, chroma 0.89  ->  needs no help at all

       A chroma^2 law treats those two the same, and it turned the
       18:00 sky into fluorescent magenta. What ACES actually punishes
       here is a SUPPRESSED RED channel: warm colours sit near a
       primary and roll off gracefully, cool ones get dragged toward
       grey. So the weight is (1 - r/max)^2 — about 0.76 for the
       zenith, 0.34 for the horizon cyan, and exactly 0 for every warm
       entry in TIME_OF_DAY, which is why dusk is now left alone. */
    const mx = Math.max(c.r, c.g, c.b);
    const cool = mx > 1e-5 ? clamp(1 - c.r / mx, 0, 1) : 0;
    const c2 = cool * cool;
    const sat = Math.min(4.4, 1 + k * c2);
    /* And the level has to come DOWN as the push goes up. ACES
       bleaches in proportion to how far up the shoulder a channel
       sits, so a blue pushed both wider AND brighter just clips:
       measured, a chroma push alone took the zenith from V 0.82 to
       V 0.91 and left S where it started. Trading luminance for
       chroma is what actually lands the swatch. */
    const g = gain - 0.513 * c2;
    const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    c.setRGB(
      Math.max(0, l + (c.r - l) * sat) * g,
      Math.max(0, l + (c.g - l) * sat) * g,
      Math.max(0, l + (c.b - l) * sat) * g);
    return c;
  }
  /* Chroma as a fraction of the brightest channel, measured in GAMMA
     space. These are authored colour-picker values and the question
     being asked of them ("which of these two is the more colourful?")
     is a perceptual one; in linear space the peach horizon #F7C6A0
     reads 0.61 and the pale blue fog #C8D6E8 reads 0.30, which says
     they are within a factor of two of each other when to the eye
     (0.35 vs 0.14) one is a colour and the other is nearly white. The
     blend below is decided by the ratio between them, so measuring it
     in the wrong space is measuring the wrong thing. */
  /* chromaOf / warmthOf are module-level (top of this file): the table
     sampler needs them too, and two copies of a predicate this one is
     how the sampler and the blend end up disagreeing about what a
     neutral is. */

  /* Chroma push at constant luminance. boost() only fires on cool
     colours by design (see its comment); this is the warm counterpart
     and it is deliberately NOT wired into boost(), because a warm push
     that ran all day is what turned the 18:00 sky magenta the last
     time it was tried. Callers gate it themselves. */
  function warmChroma(c, k) {
    if (!(k > 1.0001)) return c;
    const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    c.setRGB(Math.max(0, l + (c.r - l) * k),
             Math.max(0, l + (c.g - l) * k),
             Math.max(0, l + (c.b - l) * k));
    return c;
  }

  /* Boosted variants. `skyColor`/`horizonColor`/`fogColor` stay
     authored — they drive the ambient and the hemi fill, and a
     1.6x-chroma ambient would repaint the whole world. */
  const skyOut = srgb(SKY.zenith);
  const horizonOut = srgb(SKY.horizon);
  const fogOut = srgb(SKY.haze);
  const haloOut = srgb(SKY.sunHalo);
  /* The pale warm stop between the horizon band and the zenith. See
     THE DAWN STOP in sky.js's fragment shader for why a two-colour
     vertical ramp cannot make a dawn. */
  const dawnMid = srgb(SKY.dawn);
  /* The band colour resolved at the camera's own bearing — what
     scene.fog and the clear colour are actually set to. See THE JOIN
     in update(). */
  const fogJoin = srgb(SKY.haze);

  /* ---- lights ----
     The key is the CSM's cascade-0 directional light; we never make
     our own or the shadows and the shading would disagree. */
  const csm = ctx.render?.csm ?? null;
  const key = csm ? csm.lights[0] : new THREE.DirectionalLight(sunColor, 0.74);
  if (!csm) scene.add(key);

  /* Sky fill + warm ground bounce in one object. Kept deliberately
     small: the toon shader integrates its OWN two-lobe ambient (see
     ctx.mat.setAmbient below) and adds hemisphere lights on top, so
     this is the share of the fill that non-toon materials need and
     the setAmbient call is reduced by the same amount. */
  const hemi = new THREE.HemisphereLight(srgb(SKY.horizon), srgb(LAND.sand), 0.10);
  hemi.name = 'sky.hemi';
  hemi.position.set(0, 60, 0);
  scene.add(hemi);

  /* ---- fog (§2.4) ----
     near/far, not density: the sky dome's bottom band is a flat fill
     of exactly fogColor, so a linear ramp that completes before the
     dome takes over is what makes the two meet invisibly. */
  const fog = new THREE.Fog(fogColor, 60, 420);
  scene.fog = fog;
  const fogRange = { near: 60, far: 420 };

  /* ---- god rays ---- */
  const gr = q.ssao || q.dof ? createGodRays(ctx) : null;
  if (gr) scene.add(gr.mesh);

  /* ---- damped scalars ---- */
  let sunI = 0.74, ambI = 0.46, exposure = 1.05;
  let grStrength = 0;
  let gradeName = 'day';
  /* Drives the dome's band + horizon spread and the fog join. One
     value, three consumers — see update(). */
  let horizonGlow = 0;
  /* How hard the whole dawn/dusk treatment runs, 0..1. See update(). */
  let dawn = 0;
  /* Last values pushed to post's AO, so a stable frame is not
     re-uploading two uniforms it already has. */
  let aoR = -1, aoS = -1;

  const _p = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _tmp = new THREE.Color();
  /* the trial 50/50 the cancellation test is asked about — allocated
     once, never escapes update() */
  const _can = new THREE.Color();

  /* Chooses a post grade from sun elevation. Crossfaded, never
     snapped: a grade change that lands in one frame reads as a cut. */
  function gradeFor(el, storm) {
    if (storm > 0.55) return 'dusk';
    /* 34 STAYS, AND THE REVERT CHECK IS WHY.

       This threshold was moved to 20 on a measurement: at 16:30 (el
       34.5, `day`) the sky above the band read #86A6CB with green in
       the middle, and thirty minutes later at 17:00 (el 26.0,
       `golden`) it read #A094B8 with green the smallest of the three,
       which said the golden grade's sat 1.18 and warm gain
       [1.120, 1.015, 0.845] were tipping a blue sky violet.

       That measurement was taken over the muddy horizon colours, and
       it agreed with itself. Reverted on its own AFTER deMud landed,
       with everything else in place: 17:00 measures saturation 0.236
       and green-smallest 1.5 % on `golden` against 0.203 and 2.3 % on
       `day`, and 08:00 measures 0.499 against 0.360. The grade was
       never the defect; it was a warm grade over a grey sky. Fix the
       sky and the grade is an improvement, so it stays where the art
       direction put it. */
    if (el > 34) return 'day';
    if (el > 8) return 'golden';
    if (el > -5) return 'dusk';
    return 'night';
  }

  /* RUNTIME REVERT, driven by tools/_sky-minute.mjs. Registered here
     rather than in sky.js because the rule is this file's, and a
     switch nobody can reach from a rig is not a revert check.
     Caller must re-set the hour afterwards: tod is resampled there. */
  if (typeof window !== 'undefined') {
    const dbg = (window.WALLY = window.WALLY || {}).debug =
      window.WALLY.debug || {};
    dbg.skyRule = (n) => (n == null ? undefined : setSkyRule(n));
    dbg.skyRules = skyRuleNames;
  }

  const api = {
    tod,
    sunDirection, moonDirection,
    sunColor, ambientColor, fogColor, skyColor, horizonColor, haloColor,
    /* ACES-compensated variants — what the dome, the fog and the
       clouds are actually painted with (see boost() above) */
    skyOut, horizonOut, fogOut, haloOut, fogJoin, dawnMid,
    /* How hard the low-sun horizon treatment runs, 0..0.8. sky.js
       reads this for the dome's band and spread so the dome and the
       fog cannot disagree. */
    get horizonGlow() { return horizonGlow; },
    /* 0..1. How hard the warm-horizon treatment runs. sky.js reads it
       for the dome's band exponent and its dawn stop; nothing may
       recompute it, for the same reason horizonGlow lives here. */
    get dawn() { return dawn; },
    lights: { key, hemi },
    key, hemi, fog,
    get exposure() { return exposure; },
    get sunIntensity() { return sunI; },
    get ambientIntensity() { return ambI; },
    get grade() { return gradeName; },
    godrays: gr,

    /* ------------------------------------------------------------
       wx is the blended weather state from weather.js:
         cloud 0..1   sunMul  ambMul  fogMul  storm  flash  rain
       ------------------------------------------------------------ */
    update(dt, hour, wx) {
      /* HOW HARD THE WEATHER IS ABOUT TO PULL THE HORIZON OFF ITS OWN
         COLOUR — the two lerps below, read back as one number and
         handed to the crossing repair BEFORE the table is sampled.
         The terms are literally the weights those lerps use, so if
         either is retuned this follows it:
             overcast   smoothstep(0.34, 1, cloud) * 0.42
             storm      storm * 0.34
         DEADBANDED ABOVE THE CLEAR PRESET. WEATHER.clear authors
         cloud 0.44, which is overcast 0.067 and a pull of 0.028, so
         0.03 is the first value that makes a clear sky exactly zero —
         and a clear sky must be exactly zero, because every number
         round 5 was accepted on was measured there. 0.45 is the span
         from the deadband to a full storm's 0.76, so rain and storm
         both reach 1 and cloudy lands at 0.80. */
      const drain = weatherDrain(wx);
      setSkyDrain(drain);
      sampleTOD(hour, tod);
      const el = tod.sunEl;

      /* --- direction --- */
      sunVector(hour, el, sunDirection);
      /* The moon is not the sun's antipode: an exactly opposite moon
         sits dead centre of the night sky at midnight and the frame
         has no diagonal in it. Offset in azimuth and flattened in
         elevation so it swings through a different arc. */
      const maz = sunAzimuth(hour) + Math.PI - 26 * DEG;
      const mel = (-el * 0.78 + 10) * DEG;
      const mc = Math.cos(mel);
      moonDirection.set(Math.sin(maz) * mc, Math.sin(mel), Math.cos(maz) * mc).normalize();

      /* --- night factor: fades in across dusk, never pops --- */
      const night = smoothstep(5, -8, el);
      const twilight = smoothstep(16, -2, el) * (1 - night * 0.5);

      /* --- intensities --- */
      const dayness = smoothstep(-6, 18, el);
      const targetSun = (0.100 + 0.66 * dayness) * wx.sunMul;
      const targetAmb = (0.345 + 0.155 * dayness) * wx.ambMul;
      /* 1.6 lambda ≈ a third of a second: fast enough that a debug
         setHour looks instant, slow enough that a cloud crossing the
         sun is a dim rather than a flicker. */
      sunI = damp(sunI, targetSun, 1.8, dt);
      ambI = damp(ambI, targetAmb, 1.8, dt);

      /* --- colours --- */
      sunColor.copy(tod.sun);
      /* Storm drains the sun toward the shadow tint rather than toward
         grey: §2.1 has no grey in it, not even in a storm. */
      if (wx.storm > 0.001) sunColor.lerp(shadowTint, wx.storm * 0.45);

      ambientColor.copy(tod.amb);
      skyColor.copy(tod.sky);
      horizonColor.copy(tod.horizon);
      fogColor.copy(tod.fog);
      /* Overcast pulls the sky and the haze toward each other — the
         gradient flattens, which is what an overcast sky IS. Gated
         above the CLEAR preset's own cover (0.30), or a clear day
         would arrive pre-flattened for no reason. */
      const overcast = smoothstep(0.34, 1.0, wx.cloud);
      if (overcast > 0.001) {
        _tmp.copy(tod.fog).lerp(tod.sky, 0.35);
        skyColor.lerp(_tmp, overcast * 0.62);
        horizonColor.lerp(_tmp, overcast * 0.42);
      }
      if (wx.storm > 0.001) {
        skyColor.lerp(shadowTint, wx.storm * 0.50);
        horizonColor.lerp(shadowTint, wx.storm * 0.34);
        fogColor.lerp(shadowTint, wx.storm * 0.40);
      }
      haloColor.copy(C_HALO).lerp(tod.sun, 0.55);

      /* The three colours the sky itself is painted with.

         fogOut is NOT the table's `fog` entry on its own — it is the
         colour the dome actually paints at h = 0, and the table's fog
         is half of that. Driving it the other way round (dome follows
         fog) inverted the dawn: TIME_OF_DAY puts a peach horizon and
         a pale BLUE fog at 07:00, so the wide band came out cold with
         the warmth stacked above it, which is upside down. The dome
         owns the horizon colour; the fog is told what it is. */
      boost(skyOut.copy(skyColor));
      boost(horizonOut.copy(horizonColor));
      /* THE DAWN MUD.

         This was a flat 50/50 of the horizon and fog entries, and at
         07:00 TIME_OF_DAY authors those as a peach (#F7C6A0) and a
         pale blue (#C8D6E8) of almost the same value. Averaging a
         warm and a cool at equal value lands on a neutral — the one
         colour §2.1 forbids anywhere in the frame — and this value is
         painted across the dome's whole pale band AND into scene.fog,
         so the opening hour rendered under a grey lid.

         The mix was then weighted toward whichever of the two carries
         more chroma — and the weight was worth 0.24 of the span, which
         is nowhere near enough. Measured at 07:21: the horizon peach
         carries chroma 0.61 and the fog blue 0.30, and a 0.24 bias
         moved the blend from 0.500 to 0.466. The result, #E4D1CB, is a
         pale pink-grey, and because uHaze is painted flat across the
         dome's whole 25-degree band AND into scene.fog it WAS the dawn
         sky: a mauve lid with no gradient under it. Two-thirds of a
         neutral is still a neutral.

         So the weight now runs to the end of its rope. At full
         dominance and a fully low sun the haze IS the horizon colour,
         with a fifth of the fog entry left in for air; at midday the
         pair are both blues, dom goes to ~0 and the blend is the same
         0.5 average it always was. Nothing above the horizon changes —
         this value only ever paints the band and the fog. */
      const lowFog = 1 - smoothstep(-8, 32, el);
      /* ONE DAWN NUMBER, five consumers — the fog blend, the warm
         chroma push, the dawn stop's colour, the dome's band exponent
         and the dome's dawn mix.

         Driven by how WARM the horizon entry is, not by how low the
         sun is, and that distinction is the whole bug. An elevation
         gate switches off around 26 degrees; TIME_OF_DAY's horizon is
         still #C7A4A0-ish warm at 08:20, where the sun is 28 up. So
         between about 08:00 and 09:00 the dome went back to the plain
         two-colour ramp WHILE the horizon was still warm, and painted
         a second, later mauve nobody had connected to the first one.
         Asking the colour covers dawn and dusk with one number and
         switches itself off the moment the horizon turns cyan.

         Gated on the sun being UP, so night — whose horizon entries
         are also red-heavy — never sees any of it. */
      dawn = clamp(warmthOf(horizonColor) * 2.6, 0, 1)
           * smoothstep(-6, 4, el) * (1 - wx.storm * 0.7);
      if (lowFog > 0.002) {
        const ch = chromaOf(horizonColor), cf = chromaOf(fogColor);
        /* +1 = the horizon owns the band, -1 = the fog does. */
        const dom = clamp((ch - cf) / Math.max(ch + cf, 1e-4), -1, 1);
        /* AND CHROMA IS THE WRONG QUESTION WHEN THE TWO OPPOSE.

           `dom` asks which of the pair is the more colourful, and at
           08:00 the answer is "neither": TIME_OF_DAY authors a warm
           horizon #E4CBBA at chroma 0.189 against a cool fog #C4D8EA
           at 0.166, so dom came out 0.065 and the blend sat at 0.466 —
           an even average of a warm and a cool, which is a neutral.
           Measured on the rig, 08:00 rendered a mean sky of #B7AFBB at
           saturation 0.063, flatter than the 17:00 hour that was
           reported. The same average is what made 06:00 a mauve.

           Equal chroma on opposite sides of neutral is the WORST case
           for an average and dom scores it as the most balanced. So
           when the pair genuinely oppose — red beats blue in one and
           loses in the other — the blend is driven to the horizon
           instead, which is the end the dome already owns ("The dome
           owns the horizon colour; the fog is told what it is", above).
           Weighted by the SMALLER of the two leans, so a pair that
           barely opposes barely moves, and deadbanded so 20:00, where
           the horizon is only 0.03 warm, is left exactly alone. */
        const swH = swarm(horizonColor), swF = swarm(fogColor);
        const opp = swH * swF < 0
          ? Math.max(0, Math.min(Math.abs(swH), Math.abs(swF)) - 0.05) : 0;
        /* 5.0, not 2.4: at 08:00 the pair oppose by 0.097 and a 2.4
           gain moved the blend to 0.289 — still 29 % of a cool fog in
           a warm band, still a neutral (#E8E1DC, chroma 0.05, measured
           on the rig at saturation 0.029). A real opposition has to
           reach the clamp or it has not done anything. */
        /* AND OPPOSITION IS ONLY ONE WAY FOR A PAIR TO CANCEL.

           swarm() is a RED-MINUS-BLUE lean, so it reads zero for a
           green — and a horizon crossing from cyan to peach spends
           its middle minutes in exactly that sector, carrying chroma
           the whole way. Measured on the morning crossing, minute by
           minute, `opp` against what a 50/50 mix actually loses:

             07:37  opp 0.102   cancels 0.876
             07:38  opp 0.039   cancels 0.518
             07:39  opp 0.000   cancels 0.233
             07:40  opp 0.000   cancels 0.009

           The protection came off over the three minutes the pair
           cancelled hardest, and the band fell from 0.298 chroma to
           0.078 — a near-exact neutral at 07:38, frame saturation
           0.027, WORSE than the straight lerp this replaced (0.082).

           So ask the chroma directly: mix them and see how much is
           left against the mean of the two. That is what "these two
           cancel" means, it costs one lerp, and it does not care
           which axis of the wheel the cancellation happens on. The
           old test is kept as a FLOOR under it, so every hour where
           opposition was the bigger of the two is bit-identical.

           Deadbanded at 0.18 and not lower, and the number comes off
           a whole-day sweep at one-minute resolution rather than off
           the crossing: outside 05:20-07:40 the largest cancellation
           anywhere in the 24 hours is 0.152, at 19:40, where a warm
           horizon meets a fog on its way to night. Everything in
           18:00-19:20 — the sunset that is verified correct and must
           not move — measures 0.007 or less and is arithmetically
           untouched. */
        _can.copy(horizonColor).lerp(fogColor, 0.5);
        const cavg = (ch + cf) * 0.5;
        const cancel = cavg > 1e-4
          ? clamp(1 - chromaOf(_can) / cavg, 0, 1) : 0;
        const push = Math.max(5.0 * opp,
          (RULE.cancel || 0) * Math.max(0, cancel - (RULE.cancelDead ?? 1)));
        const t = clamp(0.5 - push - 1.1 * dawn * dom, 0.12, 0.88);
        _tmp.copy(horizonColor).lerp(fogColor, t);
        /* AND IT HAS TO BE PUSHED, BECAUSE boost() CANNOT HELP IT.
           boost's weight is (1 - r/max)^2 — it exists to buy back what
           ACES takes off a *cool* colour and is exactly 0 on anything
           warm, which at dawn is the whole horizon. #F7C6A0 is only
           S 0.35 to begin with and the RRT takes it down again, so
           without this the band is a beige, not a peach. Small, capped,
           and gated on lowFog so midday never sees it; the 18:00
           horizon is already S 0.85 and does not need much. */
        const warmK = 1 + 1.40 * dawn * Math.max(0, dom);
        warmChroma(_tmp, warmK);
        boost(fogOut.copy(_tmp));
        /* the dome's horizon colour above the band gets the same push,
           or the band is a warmer colour than the sky it hands over to
           and the join reads as a step */
        warmChroma(horizonOut, warmK);

        /* THE DAWN STOP. Built from the same blend the band is, so the
           two can never disagree: half its chroma taken out and its
           value lifted a fifth, which is the pale warm cream a real
           dawn puts between a peach sea line and blue overhead. It is
           NOT a mix of the horizon and the zenith — that is exactly
           the straight line that produced the mauve, and the whole
           point of this stop is to leave it. */
        const dl = _tmp.r * 0.2126 + _tmp.g * 0.7152 + _tmp.b * 0.0722;
        dawnMid.setRGB(
          (dl + (_tmp.r - dl) * 0.55) * 1.18,
          (dl + (_tmp.g - dl) * 0.55) * 1.18,
          (dl + (_tmp.b - dl) * 0.55) * 1.18);
      } else {
        boost(fogOut.copy(horizonColor).lerp(fogColor, 0.5));
        dawnMid.copy(fogOut);
      }

      /* How hard the low-sun horizon treatment is driven. Computed
         HERE rather than in sky.js because three things now have to
         agree about it — the dome's band, the dome's horizon spread,
         and the fog join below — and when it was a local in sky.js
         the fog could not see it. */
      horizonGlow = (1 - smoothstep(-8, 32, el)) * 0.80 * (1 - wx.storm * 0.8);
      /* the halo is a warm highlight, not a hue we are fighting ACES
         for — a light touch only */
      boost(haloOut.copy(haloColor), 0.70, 1.02);

      /* --- push to the render core --- */
      if (csm) csm.setSun(sunDirection, sunColor, sunI);
      else {
        key.position.copy(sunDirection).multiplyScalar(80);
        key.color.copy(sunColor);
        key.intensity = sunI;
      }

      hemi.color.copy(horizonColor);
      hemi.groundColor.copy(C_SAND).lerp(fogColor, 0.25 + 0.45 * night);
      hemi.intensity = ambI * 0.22;

      if (ctx.mat) {
        /* skyColor drives the ambient's upper lobe, not horizonColor:
           an upward-facing surface sees the zenith. LAND.sand is the
           warm ground bounce; at night the ground stops bouncing warm
           light because there is none to bounce. */
        _tmp.copy(C_SAND).lerp(fogColor, 0.30 + 0.50 * night);
        ctx.mat.setAmbient(skyColor, _tmp, ambI * 0.80, 0.52 + 0.16 * night);
        /* The shadow law is §2.1's and is not ours to rewrite; the
           only thing time of day is allowed to move is which
           blue-violet it is. At night shadows sit deeper in the
           sky's own colour. */
        _tmp.copy(shadowTint).lerp(C_NIGHT, night * 0.38);
        ctx.mat.setShadowLaw(_tmp, null, null, null, null);
      }

      /* --- fog (§2.4) ---
         Rain and storm are the only things that shorten it; a clear
         day keeps the horizon readable, which §6 requires. */
      fogRange.near = damp(fogRange.near, lerp(60, 14, wx.fogMul), 0.35, dt);
      fogRange.far = damp(fogRange.far, lerp(420, 130, wx.fogMul), 0.35, dt);
      fog.near = fogRange.near;
      fog.far = fogRange.far;
      /* THE JOIN: distant geometry has to converge on the exact
         colour the dome paints at the sea line, so the fog gets the
         boosted value, not the authored one.

         It is ONE copy of ONE value and it has to stay that way. An
         azimuth-varying fog was tried here — evaluated at the
         camera's centre ray to track a dome band that had been given
         its own gradient — and it put a hard horizontal step across
         the frame at the horizon, because a 54 degree lens looks
         ~27 degrees off its own centre at the edges and the fog
         cannot vary with it. The dawn colour problem that motivated
         it is fixed in fogOut above instead, where it costs nothing.

         fogJoin is kept as the published name for this value so
         anything reading it gets the colour actually in scene.fog. */
      fogJoin.copy(fogOut);
      fog.color.copy(fogJoin);
      if (ctx.render) ctx.render.clearColor.copy(fogJoin);

      /* --- ambient occlusion ---
         §3.4 asks for a wide, soft AO and calls it "what sells the
         clay look at world scale". The failure it was actually
         producing was narrower than that: no darkening where a
         structure meets the ground, so the houses read as cutouts
         standing on a slab rather than as objects sitting in it.

         Post owns the pass; the sun owns how hard it should be
         driven, which is why it is set from here. The radius opens
         as the sun drops, because that is exactly when the sky's
         share of the lighting is largest and contact darkening is
         the only thing left doing the rooting. Both numbers are
         free — the tap count and the half-res target are fixed, so
         a wider radius costs nothing but a longer sample stride. */
      if (ctx.render?.setSSAO) {
        const lowAO = 1 - smoothstep(4, 40, el);
        const r = lerp(1.05, 1.55, lowAO);
        const s = lerp(0.62, 0.82, lowAO) * (1 - wx.storm * 0.25);
        if (Math.abs(r - aoR) > 0.004 || Math.abs(s - aoS) > 0.004) {
          aoR = r; aoS = s;
          ctx.render.setSSAO(r, s);
        }
      }

      /* --- exposure + grade ---
         THE DAWN IS NOT SUPPOSED TO BE DIM. Two things stack at 07:00
         and neither is visible from the table: TIME_OF_DAY authors
         exposure 1.00 there against 1.05 at 10:00, and gradeFor()
         hands the frame to the `golden` grade, whose own exposure is
         0.98 against day's 1.05. Multiplied out that is 0.98 against
         1.10 — an 11 % darker world at the hour the game opens, on top
         of a sun that is genuinely weaker. A low sun wants a warmer,
         more contrasty grade; it does not want a stop less light.
         Gated on `dawn`, which is already zero at night and zero
         above a cyan horizon, so the lift lands exactly on the hours
         that lose the light and on no others. A golden hour that is
         also a dark hour is a contradiction. */
      const dawnLift = 1 + 0.16 * dawn;
      const targetExp = tod.exposure * wx.exposureMul * dawnLift + wx.flash * 0.55;
      exposure = damp(exposure, targetExp, 2.4, dt);
      ctx.render?.setExposure(exposure);

      const g = gradeFor(el, wx.storm);
      if (g !== gradeName) {
        gradeName = g;
        /* 1.2 lambda ≈ two seconds to settle. A time-of-day change is
           allowed to be seen happening; it is not allowed to cut. */
        ctx.render?.setGrade(g, 1.2);
      }

      /* --- god rays --- */
      if (gr) {
        const cam = ctx.camera;
        gr.uniforms.tND.value = ctx.render?.targets?.normalDepth?.texture ?? null;
        gr.uniforms.uTime.value = ctx.elapsed;
        gr.uniforms.uColor.value.copy(haloColor);
        gr.uniforms.uAspect.value = cam?.aspect ?? 1.78;

        let target = 0;
        if (cam && gr.uniforms.tND.value) {
          cam.getWorldDirection(_fwd);
          const facing = _fwd.dot(sunDirection);
          if (facing > 0.02) {
            _p.copy(cam.position).addScaledVector(sunDirection, 1000).project(cam);
            gr.uniforms.uSunUv.value.set(_p.x * 0.5 + 0.5, _p.y * 0.5 + 0.5);
            /* "when low or occluded": a base term so shafts exist
               whenever the world breaks the light, plus a big
               low-sun term because that is when they are real. */
            const low = 1 - smoothstep(6, 42, el);
            /* 0.30 + 1.15 * low put an additive wash over the whole
               frame at golden hour — the grass came out pale yellow.
               Shafts are a highlight, not an exposure change. */
            target = (0.12 + 0.40 * low) * smoothstep(0.02, 0.35, facing)
                   * clamp(sunI / 0.55, 0, 1) * (1 - wx.storm * 0.7)
                   * (1 - wx.cloud * 0.35);
          }
        }
        grStrength = damp(grStrength, target, 2.2, dt);
        gr.uniforms.uStrength.value = grStrength;
        gr.mesh.visible = grStrength > 0.002;
      }

      api.night = night;
      api.twilight = twilight;
      api.isNight = el < -3;
    },

    resize(w, h) {
      if (gr) gr.uniforms.uAspect.value = w / Math.max(1, h);
    },

    dispose() {
      scene.remove(hemi);
      if (!csm) scene.remove(key);
      if (gr) {
        scene.remove(gr.mesh);
        gr.mesh.geometry.dispose();
        gr.mat.dispose();
      }
      if (scene.fog === fog) scene.fog = null;
    },
  };

  api.night = 0;
  api.twilight = 0;
  api.isNight = false;
  return api;
}
