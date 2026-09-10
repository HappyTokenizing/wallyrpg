/* ============================================================
   contracts.js — the shared spine of WALLY RPG.

   READ THIS BEFORE WRITING ANY MODULE.

   Every subsystem in this game is a module that exports exactly one
   function:

       export async function init(ctx) { ...; return handle; }

   `ctx` is the single shared context object created here. A subsystem
   may READ anything on ctx, but may only WRITE to the namespace it
   owns (declared in OWNERSHIP below). This is what lets many agents
   build in parallel without colliding.

   The returned `handle` may implement any of:

       update(dt, elapsed)   called every frame, before render
       lateUpdate(dt)        called after update, before render (camera, IK)
       resize(w, h)          called on viewport change
       dispose()             called on teardown

   Nothing else is required. A subsystem that returns nothing is legal.

   ============================================================
   HOW THIS PROJECT PROVES A FIX — READ THIS BEFORE WRITING A TEST

   Nine assertions in this repo have been green for the wrong reason.
   A census read 0.0 mm everywhere because it only ever sampled the
   terrain's own lattice. A drivetrain probe reported a reversed wheel
   because it unwrapped an angle turning more than pi per frame. None
   of those failed; they agreed with themselves. Four rules, each of
   which was paid for:

   1. A REVERT CHECK RUNS TODAY'S TEST AGAINST YESTERDAY'S CODE.
      That direction is the whole content of the idea, and it is the
      one that is easy to get backwards. Yesterday's test against
      yesterday's code PASSES BY CONSTRUCTION — they were written
      together, in the same commit, and agree about what the world
      looked like then. So "tools/cliptest.mjs fails against a clean
      HEAD archive" is a claim about anything only if it means the
      WORKING TREE's cliptest run against HEAD's src. HEAD's own
      cliptest against HEAD's src is not a revert check and says
      nothing; it is the definition of a passing build. That sentence
      has been written loosely in several briefs, this file's included.

      A quoted before-number is not a revert check either. It is a
      citation. It stays in the file, word for word, after the fix it
      refers to has been deleted, and it goes on reading like evidence.
      The strong forms, in order of preference:
        · a switch in the module, shipping rule and prior rule side by
          side, driven on the same page load
          (hud.js promptAnchor('slide' | 'lintel'), driven by
          tools/touchtest.mjs PROMPT-5..9);
        · a wrapper over the public API the fix goes through, for a fix
          that is a call added at a seam between modules
          (main.js RUNTIME REVERTS / WALLY.debug.revert(), driven by
          `node tools/introhandover.mjs --revert`);
        · failing those, a CHECKED-IN FIXTURE, labelled as a fixture,
          carrying the date and the rig it was captured on.

   2. NAME THE BRANCH EVERY ASSERTION EXERCISES. If you cannot write
      down which line of which file makes an assertion true, you do not
      yet know what it is measuring, and neither will the person who
      changes that line.

   3. A MEASUREMENT THAT SAMPLES A SPECIAL CASE WILL AGREE WITH ITSELF.
      Before you believe a number, vary the thing you did not choose:
      the camera azimuth, the sample positions, the ride, the viewport,
      the frame rate. A claim about a general property that was only
      ever measured in one configuration is a claim about that
      configuration. Either assert it per configuration with the real
      values, or assert the property that is true in all of them.

   4. STATE THE RIG BESIDE THE NUMBER. Software GL and a real GPU are
      not comparable, and neither are a capped and an uncapped frame.
      "6.5 ms median (M1 Max, ANGLE Metal, 1600x900, limiter off)" is a
      measurement; "161 fps" on its own is a rumour. And a single
      frame's reciprocal is not an fps at all — see THE FRAME CENSUS in
      main.js for what window.__WALLY_PERF__ publishes and why.

   5. A RIG THAT CANNOT REACH ITS SUBJECT MUST DIE, NOT SHRUG.
      `--place mainstreet` is not a location id — 'mainstreet' is a
      ZONE — so WALLY.debug.arrive() returns false for it, and a rig
      that catches that false and carries on shoots THE BOOT POSITION
      IN THE GRASS while its header says Main Street. A whole family
      of rigs on this project did exactly that. Two habits close it:
      exit non-zero on anything but `arrive(...) === true`, and print
      where the camera ACTUALLY ended up — eye position, the ground
      height under it, the zone it is standing in — beside every
      table. Same for any state a screenshot poses: after the world is
      frozen, a setter's return value proves nothing, because the
      module that owns the uniform has stopped running and may have
      left the shader reading the old value (toon.js and
      uOutlineScale; see tools/_k27-olcheck.mjs). Read the live
      uniform, not the setter.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';

/* ------------------------------------------------------------
   OWNERSHIP — which module may write which ctx namespace.
   ------------------------------------------------------------
   ctx.render     render/*        renderer, composer, passes, quality
   ctx.mat        render/toon.js  material factories
   ctx.wind       core/wind.js    global wind uniforms
   ctx.sky        world/sky.js    sky, sun, lighting rig, time of day
   ctx.world      world/*         terrain, city, props, foliage
   ctx.water      world/water.js  ocean + ripples
   ctx.wally      character/*     the player character + rig + anim
   ctx.phys       physics/*       collision world, controller
   ctx.cam        core/camera.js  camera rig
   ctx.game       game/*          state, economy, quests, save
   ctx.ui         ui/*            hud, phone, dialogue
   ctx.intro      intro/*         the opening cinematic
   ctx.audio      audio/*         music + sfx
   ------------------------------------------------------------ */

/* Tiny synchronous event bus. Subsystems talk through this, never by
   importing each other. `on` returns an unsubscribe function. */
export function createBus() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    once(type, fn) {
      const off = this.on(type, (...a) => { off(); fn(...a); });
      return off;
    },
    emit(type, payload) {
      const s = map.get(type);
      if (!s) return;
      for (const fn of [...s]) {
        try { fn(payload); }
        catch (e) { console.error(`[bus] ${type} handler threw:`, e); }
      }
    },
    clear() { map.clear(); },
  };
}

/* ============================================================
   QUALITY TIERS.

   A TIER IS A PROMISE ABOUT A FRAME TIME, NOT A WISH LIST. The table
   this replaces made no such promise and could not have kept one:
   measured in the Main Street fly-to at 1600x900 on an M1 Max — the
   heaviest scene in the game — it ran

     low    120 fps      (8.3 ms)   twice its target, and looked it
     med     70 fps     (14.2 ms)
     high    48 fps     (20.7 ms)   <- the DEFAULT for a good GPU
     ultra   46 fps     (21.9 ms)   <- what pickQuality actually chose

   and on a Retina panel, where devicePixelRatio is 2, high and ultra
   asked for `min(devicePixelRatio, 2)` and rendered 5.8 megapixels
   instead of 1.4: measured, 31 fps. So the tier the probe handed this
   machine missed 60 fps by a factor of two, and the tier below it
   missed by 25 %, while the bottom tier had 100 % of headroom it was
   not spending on anything.

   WHAT THE FRAME IS ACTUALLY MADE OF, measured at high, 1600x900,
   pixelRatio 1, by alternating the streamed foliage on and off six
   times inside one process:

     whole frame                20.4 ms
     everything except grass    15.0 ms
     the grass field             5.4 ms

   Three conclusions drive every number below.

   1. pixelRatio > 1 is the single most expensive line in the table
      and it buys the least: SMAA already resolves the edges. Every
      tier now renders at 1:1. That alone is 51 fps against 37 on this
      machine.
   2. A shadow cascade is a second traversal of a 1500-call scene.
      Dropping high from three to two, and its bloom chain from five
      mips to four, is 2.2 ms — more than a third of the whole grass
      field — for a difference that lives in the far half of the
      shadow map.
   3. Grass is bought by DISTANCE, not by density. Thinning the
      carpet is what two blind reviews called "acid shards"; the
      near field is the whole read. So the ladder moves grassDist
      48 / 70 / 92 / 110 and keeps density high everywhere, and low
      gets MORE grass than it used to have, not less, because it was
      the tier with a hundred per cent of headroom and the sparsest
      field in the game.

   Every expensive feature still checks ctx.quality before switching
   itself on. Tier is chosen at boot from a GPU probe, may be forced
   with ?quality=low|med|high|ultra, and may be pinned per device from
   the Settings menu — which RELOADS, because almost nothing in this
   table can be re-applied to a world that is already built (see
   qualityPin below, and the note over the Quality row in menus.js).
   ============================================================ */
/* ============================================================
   THE PIXEL RATIO IS NOT A CONSTANT ANY MORE — AND WHY IT WAS ONE.

   Point 1 of the block above ("every tier now renders at 1:1") is a
   correct conclusion drawn on a DESKTOP viewport and then written into
   the table as a universal. It cost 4.4 megapixels at 1600x900 on a
   Retina panel, which is a real 31 fps; it costs nothing on a phone,
   because a phone's CSS box is 0.33 Mpx and dpr 2 over it is 1.32 Mpx
   — LESS than the 1.44 Mpx frame tier high already ships and holds 60
   in. So a single hardcoded `pixelRatio: 1` was making a phone render
   a third of a megapixel and letting the compositor scale it 3x, and
   renderer.js's maxPixelRatio() could only ever clamp DOWNWARD from
   it, so its own guard comment ("a phone at dpr 3 is the case that
   finds this") could never bind. MEASURED, before the change: on a
   390x844 mobile context, renderer.getPixelRatio() was 1 at
   devicePixelRatio 1, 2 AND 3, backing store 390x844 in all three.

   THE COST IS PIXELS, NOT dpr. So the cap is a MEGAPIXEL BUDGET, and
   the dpr ceiling is only a second, blunter guard on top of it:

       ratio = min( pixelRatioMax, devicePixelRatio,
                    sqrt(pixelBudget * 1e6 / (cssW * cssH)),
                    GL_LIMIT / max(cssW, cssH) )

   A budget is orientation-invariant (390x844 and 844x390 get the same
   answer, a dpr constant does not) and it self-limits on a big panel:
   an iPad's 1194x834 box lands on 1.19, not on 2. That is the property
   that makes it safe on hardware nobody here has ever run.

   WHAT EACH TIER GETS, AND WHY EXACTLY THAT.
     low   max 1.5, budget 0.75 Mpx — the weakest class we ship to
           (old handsets, integrated Intel). One notch of the ladder,
           and it stops there.
     med   max 2.0, budget 1.40 Mpx — every modern phone and tablet.
           On a 390x844 handset that is the 1.32 Mpx frame measured
           FLAT against 0.33 Mpx here; on a 1194x834 iPad the budget
           binds first at 1.19 and it never sees 2.
     high  max 1.0 — UNCHANGED, and deliberately. high's 1600x900
           frame was retuned to hold 60 at exactly 1.44 Mpx and then
           spent its winnings on msaa 4 (+2.99 ms at the worst hour),
           leaving 17 % of the budget. Adding pixels eats that margin,
           and re-earning it means re-running the msaa A/B at the new
           pixel count. Not done, so not taken. `pixelBudget` is
           declared anyway so the day it IS taken, it is one number.
     ultra max 1.0 — opt-in only; same reasoning.

   AND NONE OF THOSE CEILINGS IS WHAT BOOTS. `pixelRatio` is still 1
   on every tier and is still what the first frame renders at — i.e.
   the exact frame this project has always measured. The ceiling is
   only what the frame-time governor in renderer.js is ALLOWED to
   climb to, one notch at a time, and only while nothing is missing
   60 fps. On an iPhone 12 or a mid-range Android — hardware nobody
   here has measured or can measure — that is the honest instrument:
   the device answers the question itself, in about a second and a
   half, and the worst case it can leave you in is the frame that
   shipped before this paragraph existed. See renderer.js "THE
   SHARPNESS GOVERNOR".
   ============================================================ */
/* bloomMips IS A SAFETY NUMBER AS WELL AS A LOOKS NUMBER, AND 3 IS A
   FLOOR. A non-finite texel that reaches the scene buffer is smeared
   by the bloom pyramid into a solid black block roughly 2^(mips+1) px
   on a side — MEASURED cold-boot per tier: 94x106 at 3, 206x218 at 4,
   428x432 at 5. tools/blacksquares.mjs is what catches that block, and
   its floor is a measured 36x36. At 2 mips the block MEASURES 38x42
   (area 1554) — 1.1x that floor, and under both of its solid-pass side
   floors, so one of its two detectors goes blind and the gate is down
   to detector 1b alone. Do not lower any bloomMips below 3 to buy
   frames: postfx.js clamps at 3 and blacksquares FAILS the gate on a
   tier that asks for less. Drop `bloom: false` instead — a tier with
   no pyramid cannot make the block at all. */
export const QUALITY_TIERS = {
  /* Integrated graphics and phones. Measured 120 fps here, which is
     the point: this tier has to hold 60 on a machine three to four
     times slower than the one it was measured on. */
  low: {
    name: 'low',
    pixelRatio: 1, pixelRatioMax: 1.5, pixelBudget: 0.75,
    shadowCascades: 1, shadowSize: 1024, shadowSoft: false,
    ssao: false, bloom: true, bloomMips: 3, dof: false,
    outline: true, grain: true, grass: 0.90, grassDist: 46,
    waterReflect: false, particles: 0.3, anisotropy: 2, msaa: 0,
  },
  /* Older discrete parts. DOF comes off here rather than at high:
     it is a full-screen pass, and a tier for a weak GPU should spend
     its budget on the things that are in focus.

     msaa STAYS 0, AND THAT IS NOW A MEASUREMENT RATHER THAN A
     DEFAULT. This is the tier a phone gets, and the phone's budget
     already took it from 0.33 Mpx to 1.32. Scored against the same
     supersampled ground truth the `high` block below describes, in a
     390x844 CSS box at deviceScaleFactor 3 (tools/_k27-ref.mjs
     --phone, freeze proof 1.55, drift 8.407 -> 8.425):

       pr  msaa   Mpx     RMSE(frame)    gpu ms
       1    0    0.329       8.407         5.12
       1    4    0.329       8.283         5.16
       2    0    1.317       3.833         6.39   <- what it ships
       2    2    1.317       3.678         6.88
       2    4    1.317       3.550         7.34
       3    0    2.962       3.177        10.62

     Climbing ratio 1 -> 2 bought 4.574 RMSE for 1.27 ms (3.60/ms).
     MSAA 4 on top of it buys 0.283 for 0.95 ms (0.30/ms) — a twelfth
     of the value, for 15 % of this tier's whole GPU frame. And that
     15 % is the OPTIMISTIC figure, because it was measured on an
     M1 Max standing in for a handset, which is the exact reason the
     sentence above about unmeasured milliseconds exists. A fixed cost
     here would also make the governor's climb harder to earn on the
     devices that most need it. Rejected on the numbers.

     ----------------------------------------------------------------
     HOW MUCH OF THE RESOLUTION AXIS THIS TIER ACTUALLY TAKES, AND
     WHERE THAT WAS MEASURED. The ceiling of 2 is not the top of the
     axis — ratio 3 is what a dpr-3 handset could in principle draw —
     so the honest statement of the gain is the share of the range
     between ratio 1 and ratio 3 that shipping at 2 has taken, with
     msaa held at this tier's own 0 so nothing but the ratio moves:

         (edgeW@1 - edgeW@2) / (edgeW@1 - edgeW@3)

     tools/_k28-acuity.mjs --only phone, 390x844 @ deviceScaleFactor 3,
     hasTouch + mobile UA (tier med), h12.5, governor off, ratio and
     samples switched live on one page load, THREE independent page
     loads, M1 Max, box load 3.1-4.2:

       run   edgeW@1   edgeW@2   edgeW@3   share of available
        1     3.703     2.762     2.493         77.8 %
        2     3.727     2.767     2.454         75.4 %
        3     3.697     2.762     2.486         77.2 %

     — 77 %, median of three, TAKEN AT eye [-102.78, 14.63, 71.88],
     ground 13.53 m, zone 'mainstreet': the Bent Spoon doorstep, where
     _k27-ref, _k27-cost, _k29-crawl and _k30-inv also stand.

     FOR SCALE, the same rig at the same doorstep on the desktop block
     (1600x900 @ dsf 2, tier high, msaa held at 2): edgeW 3.091 at
     ratio 1, 2.755 at the ceiling of 1.264, 2.238 at ratio 2 — 39.4 %
     of its available axis. The handset takes twice the share of its
     range that the desktop does, which is the shape the two budgets
     were written to have: 2.30 Mpx on `high` is a margin decision
     against a 16.67 ms promise, 1.40 Mpx here is most of what the
     panel can show.

     THE FIGURE THIS REPLACES WAS 70.8 %, AND THE INTERESTING PART IS
     WHICH OF ITS TWO FAULTS ACTUALLY MOVED IT. _k28-acuity's default
     was `--place mainstreet`; 'mainstreet' is a ZONE, arrive() returns
     false for it, and the rig caught that false and shot the BOOT
     POSITION at [0, 14.47, 0] in the grass at 'marketsq'. It also
     called its measurement crop the 'world' crop while a census now
     puts 57-61 % of it on the PLAYER CHARACTER's head at point-blank
     range — a matte clay dome whose only hard edges are his
     sunglasses. Driven as a 2x2 on the same instrument (`--place
     boot` is the switch that file now carries so the old stand can be
     driven rather than quoted, and `--wally` keeps him in the frame):

       stand              character   share of available
       boot / marketsq    in            69.7 %      <- what shipped
       cafe / mainstreet  in            70.8 %
       cafe / mainstreet  hidden        77.2 %      <- the world

     So the position was wrong and it was worth about one point; the
     SUBJECT was wrong and it was worth six. A rig that had printed
     its eye position would have been caught three rounds ago, which
     is why it prints one now — but the census is the line that would
     have caught this particular number, and no previous version of
     this file had one. Both are in it. */
  med: {
    name: 'med',
    pixelRatio: 1, pixelRatioMax: 2, pixelBudget: 1.40,
    shadowCascades: 2, shadowSize: 1280, shadowSoft: true,
    ssao: true, bloom: true, bloomMips: 4, dof: false,
    outline: true, grain: true, grass: 1.15, grassDist: 58,
    waterReflect: false, particles: 0.6, anisotropy: 4, msaa: 0,
  },
  /* THE DEFAULT, AND THE ONE THAT HAS TO HOLD 60 AT 1600x900 IN THE
     CITY. Everything here was moved for a measured millisecond:
     pixelRatio 2 -> 1, a third shadow cascade and a fifth bloom mip
     gone, and the grass ring pulled from 110 m to 88 while its
     density stays near full so the near field is untouched.

     msaa 0 -> 4 IS THE ONE LINE THAT BUYS QUALITY RATHER THAN TIME,
     and it is what the pixelRatio cut above was spending its winnings
     on all along: that note says "SMAA already resolves the edges",
     but nothing in this build has ever run SMAA — the chain ends in
     FXAA, a post filter that cannot recover an edge narrower than the
     pixel it is looking at, which is most of what the detail pass just
     added (0.05 m is a third of a pixel at 30 m). `msaa` has been in
     this table since it was written and renderer.js never read it.
     MEASURED at the Bent Spoon doorstep with the GPU saturated (four
     renders per rAF, so its clock cannot drop out from under the
     reading), one boot per value, and AT TWO HOURS, because the cost
     is the shadowed half of the frame and midday is the cheap case:

       1600x900  h12.5   9.68 -> 11.60 ms   (+1.93)
       1600x900  h07.0  10.88 -> 13.87 ms   (+2.99)   <- the worst
       390x844   h12.5   6.35 ->  6.89 ms   (+0.54)
       Green Edge h07.0  9.73 -> 12.48 ms   (+2.75)

     and +0.0 ms of CPU and +0 draw calls at every one of them: this is
     paid in the raster, not in the submission, which is the half of
     this frame that has the room. 60 fps holds at all four (frame
     16.67 -> 16.68 ms), and the worst case leaves 17 % of the 16.67 ms
     budget spare against 35 % before. 2x was measured too and is NOT
     the cheaper deal: 13.26 ms, i.e. 80 % of 4x's cost for half its
     samples — nearly all of the bill is the multisampled buffer and
     its resolve, not the sample count. low and med keep 0: their
     promise is a frame time on hardware this was never measured on,
     and an unmeasured 3 ms is not theirs to spend.

     ----------------------------------------------------------------
     msaa 4 -> 2, pixelRatioMax 1 -> 1.5, pixelBudget 1.60 -> 2.30.
     THE TRADE ABOVE WAS NEVER TAKEN AGAINST ITS ALTERNATIVE. The
     paragraph above compares MSAA against NOTHING; it never asked what
     the same milliseconds buy on the resolution axis, and this tier
     spent 1.44 Mpx to afford them. The result was that a Retina
     desktop became the blurriest surface in the game — edge smear
     3.692 output px against the phone's 2.756 after its own budget
     landed.

     THE MEASUREMENT edgeW COULD NOT MAKE. Edge smear width is what
     _j26-sharp reports and it RANKS ANTIALIASING BACKWARDS: an aliased
     step is one pixel wide and scores beautifully while looking like a
     flight of stairs. So the trade was scored the way AA is always
     scored — RMSE against a supersampled ground truth (pixelRatio 4 +
     MSAA 4, a 6400x3600 buffer composited onto the same 3200x1800
     surface), which penalises BLUR and JAGGIES in one number. The
     world was frozen (every subsystem hook nulled but the renderer's)
     and the freeze proven: the same setting captured twice, 30 s
     apart, differs by RMSE 1.53, far below every row.
     THE SHIPPING FRAME, BEFORE AND AFTER, MEASURED DIRECTLY RATHER
     THAN INTERPOLATED — same frozen instant, one page load, freeze
     proof 1.52, drift row 7.769 -> 7.770:

       pr 1     / msaa 4   frame 7.769   detail 7.291   wally 10.805
       pr 1.264 / msaa 2   frame 6.538   detail 5.932   wally  9.607
                            -15.8 %       -18.6 %        -11.1 %

     and msaa 2 is still earning its place at that ratio: dropping it
     to 0 costs 0.129 on the frame and 0.538 on the detail crop, which
     is MORE than it was worth at ratio 1. That is why this is 2 and
     not 0.

     tools/_k27-ref.mjs, one page load, ratio AND samples switched live
     (WALLY.debug.pixelRatio / WALLY.debug.msaa), cafe, h12.5,
     1600x900 @ deviceScaleFactor 2. Cost from tools/_k27-cost.mjs on
     the same instrument the rows above used — four renders per rAF, so
     the GPU clock cannot drop out from under the query — at h07.0,
     the expensive hour, M1 Max, box load 3.9-4.5 throughout, first row
     re-measured last and agreeing to 2 %:

       pr   msaa   Mpx     RMSE(frame)   RMSE(wally)    gpu ms
       1     0     1.44       7.229        10.164        10.18
       1     2     1.44       7.080        10.059        11.32
       1     4     1.44       7.050        10.023        11.84   <- shipped
       1.25  0     2.25       6.096         8.622        13.08
       1.25  2     2.25       5.947         8.531        14.35   <- now
       1.5   0     3.24       5.099         7.271        16.50
       1.5   2     3.24       4.952         7.164        19.44
       2     0     5.76       3.929         5.476        30.97
       2     4     5.76       3.503         5.129        39.76   <- ultra

     PER MILLISECOND, WHICH IS THE ONLY HONEST COMPARISON: MSAA 4 at
     ratio 1 buys 0.179 RMSE for 1.66 ms (0.108/ms). Ratio 1 -> 1.25
     buys 1.133 for 2.90 ms (0.391/ms). Resolution is 3.6x the value of
     MSAA per millisecond, and stays ahead until ratio 1.5, past which
     it falls to 0.081/ms and MSAA is the better buy again. Solved for
     EQUAL COST, MSAA 4's 1.66 ms is worth ratio 1.15 — which scores
     6.58 against MSAA 4's 7.05. The alternative wins the trade the
     paragraph above never ran.

     AND THE ASYMMETRY IS THE ART ARGUMENT, not a tiebreak. MSAA
     smooths geometric edges and NOTHING ELSE. Looked at, at 3x, in
     shots/k27/wally-face-4up.png and roofline-4up.png (the ground
     truth is the fourth panel of each, and
     before-after-groundtruth.png is the shipping frame either side of
     this change): at ratio 1 the film grain is a coarse clumpy speckle —
     §1.2's "reads dirty" failure, the same defect the phone's budget
     was written to fix — and msaa 0 and msaa 4 are INDISTINGUISHABLE
     there, because grain is a post pass at buffer resolution. The
     three incised trunk lines (§1.5) read as two broken dashes at
     ratio 1 and MSAA does not recover one of them. The glint's round
     caps (§1.4, "must read at 32 px") are square at ratio 1 under both
     sample counts, because the glint is painted into the lens
     material, not a silhouette. Every load-bearing surface law in §1
     is a resolution property MSAA cannot touch.

     WHAT MSAA DOES DO, and it is real: the roof gable diagonal and the
     glasses' brow bar against the sky are visibly stepped at msaa 0
     and smooth at msaa 4. That is why this is 2 and not 0. And it is
     NOT a job the inverted-hull outline had already done — measured
     with the hull switched off (tools/_k27-ref.mjs --nooutline),
     MSAA 4's gain is 0.162 against 0.179 with it on, i.e. unchanged.
     (That control silently measured nothing on its first run: toon.js
     writes uOutlineScale from its own update(), so turning the hull
     off AFTER the freeze leaves the shader reading 1 while setOutline
     reports 0. tools/_k27-olcheck.mjs prints the live uniform and is
     the thing that caught it.)

     WHY 2.30 Mpx AND NOT A BIGGER NUMBER. At 1600x900 it puts the
     ceiling at sqrt(2.30/1.44) = 1.264, which measures 14.4 ms at
     h07 — 14 % of the 16.67 ms budget spare. Ratio 1.4 would leave
     2 %. The budget is a megapixel budget rather than a ratio for the
     reason the phone block gives: a 1920x1080 Retina window gets
     ceiling 1.05 and a 2560x1440 one gets 1.0, self-limiting on
     exactly the panels that cannot afford it.

     ----------------------------------------------------------------
     AND NOW THE AXIS EVERY ROW ABOVE IS BLIND TO: THEY ARE ALL
     STILLS. _k27-ref FREEZES THE WORLD to take them, and aliasing's
     worst artefact is TEMPORAL — the roofline that crawls as you pan,
     the grass that boils as you walk — which is also the artefact
     MSAA suppresses best relative to resolution. Nothing in this
     chain damps it: renderer.js §3 ends in FXAA and there is no TAA
     anywhere. So "resolution beats MSAA per millisecond" was proven
     on exactly the axis where MSAA is weakest.

     tools/_k29-crawl.mjs measures the other one. Two things made it
     possible and they matter more than any single number:

     1. THE MOTION IS SCRIPTED, NOT LIVED. The world is frozen as
        above and the CAMERA is stepped by the displacement one 60 fps
        frame would give it, so step k is the pose at t = k/60 s.
        Shutter time then stops mattering and a 0.2 s page.screenshot
        can sample a 16.7 ms phenomenon. The previous attempt
        (tools/_k28-shimmer.mjs) sampled at 4 Hz with the camera
        STILL, which is the one case that cannot show camera-driven
        crawl at all.
     2. THE SEPARATION IS SUBTRACTION, NOT FILTERING. The same
        scripted instants are captured twice, once at the option and
        once at the pr4+msaa4 ground truth. E = C - R is then the
        sampling error ALONE, because the pan, the walk, the parallax
        and the shading are identical in both and cancel — no motion
        model, no flow estimate, nothing to tune. cH is the second
        time difference of E: how the error JUMPS rather than how it
        moves, because a coarse edge does not slide, it holds for
        several frames and steps a whole pixel, while a blur error
        translates smoothly and contributes only its curvature.
        tools/_k29-synth.py is the control that proves cH measures
        that and not blur — on one translating edge at 0.25 px/frame,
        MSAA 4 cuts cH 47 % while quadrupling the pixels makes it
        WORSE. (That file's first version point-sampled its reference
        instead of area-averaging it, which ranked resolution
        backwards on every row and looked exactly like a finding.)

     THE FLOOR IS ZERO, NOT 1.8x. Two independent traversals of the
     same timeline at the same setting come back BITWISE IDENTICAL —
     sE 0, cA 0, cH 0, every motion, every region, second pass taken
     last. _k28-shimmer's own drift was larger than the axis it was
     trying to resolve; this has none, so every digit is signal. Film
     grain is off for the measurement: it is a per-frame random field
     at BUFFER resolution, so it cannot cancel between two buffers of
     different size, and it is not aliasing.

     WHAT IT FOUND. Five motions, 1600x900 @ dsf 2, h12.5, 48 steps of
     60 Hz motion each, ratio and sample count switched live on ONE
     page load per motion, Wally hidden, ratios against the shipping
     pr 1.264 / msaa 2 (cH, the crawl column):

       motion (measured image speed)   pr1/ms4   ms0     ms4    pr1.5
       roofline pan       8 px/frame    1.161   1.098   0.951   0.862
       fence strafe       5 px/frame    1.178   1.060   0.960   0.846
       grass walk         4 px/frame    1.102   1.095   0.941   0.880
       orbit a corner     6 px/frame    1.052   1.201   0.931   0.880
       balloon drift      1 px/frame    0.940   1.155   0.961   0.989
       still error sE, same five rows  1.10-1.27 1.05-1.07 ~0.97 0.84-0.89

     THE TRADE HOLDS, AND THE CEILING OF 1.5 STAYS. The option this
     replaced, pr 1 / msaa 4, is worse on crawl in four motions of
     five, and its still-frame penalty is 10-27 % throughout. MSAA
     does carry a temporal premium; it is real, it is measured, and it
     is far too small to reverse a 20 % gap.

     MSAA 2 -> 0 IS REJECTED HARDER IN MOTION THAN AT REST, and that
     is what changes about `msaa: 2`. Dropping it costs 5-7 % of the
     still error and 6-20 % of the crawl, in every motion. The worst
     case is the ORBIT and it is the one that should be: a silhouette
     that ROTATES against sky sweeps its corner through every
     sub-pixel phase, and coverage is the only thing that damps that.
     The still argument for keeping 2 was 0.129 RMSE on the frame; the
     temporal argument is three times its size.

     WHERE IT DOES NOT HOLD, STATED PLAINLY. On the balloon drift —
     125 m up, the island sliding past at 1 surface px/frame — pr 1 /
     msaa 4 crawls LESS than what ships (0.940x) and ratio 1.5 buys
     nothing at all (0.989x) despite an 11 % still gain. The roofline
     speed sweep says half of that is SPEED (rate driven from 1 to 16
     surface px/frame on one page load, cH against the same shipping
     row):

       image speed   pr1/ms4   ms0     ms4    pr1.5/ms2
        1 px/frame    1.036   1.132   0.937    0.896
        2 px/frame    1.157   1.039   0.957    0.860
        4 px/frame    1.184   1.062   0.947    0.856
        8 px/frame    1.162   1.098   0.951    0.862   <- reproduces
       16 px/frame    1.172   1.081   0.955    0.853      the run above

     MSAA's crawl value RISES as the image slows and resolution's
     falls, exactly as _k29-synth predicts, and the crossover is below
     1 px/frame. The other half is content: at balloon altitude every
     feature is already sub-pixel, so a sharper buffer only re-samples
     detail it still cannot resolve. It is also the frame with the
     LOWEST absolute crawl of the five (cH 4.8 against the roofline's
     14.2) — the case where the ranking flips is the case where the
     artefact is smallest, which is why it does not buy a
     mode-dependent sample count.

     SO WHY IS msaa STILL 2 AND NOT 4, GIVEN ALL THAT? On COST, and
     the number that decides it had never been measured: msaa 2 -> 4
     AT THE CLIMBED RATIO. tools/_k27-cost.mjs, h07, same instrument
     and same page-load rule as the table above, one block, load
     3.59 -> 5.54 with the first row re-measured last and agreeing to
     1.0 % (10.41 -> 10.51 ms):

       pr 1     msaa 0  10.41    pr 1.25  msaa 0  13.13
       pr 1     msaa 2  12.04    pr 1.25  msaa 2  14.46
       pr 1     msaa 4  11.95    pr 1.25  msaa 4  15.72   <- the new row
                                 pr 1.5   msaa 0  16.36
                                 pr 1.5   msaa 2  19.99

     +1.26 ms, not the +2.5 that had been assumed — at ratio 1 the two
     sample counts are indistinguishable (12.04 vs 11.95, 0.75 %
     apart, which is this instrument's noise), and the whole bill only
     appears once the buffer is 2.25 Mpx. Affordable, then, but only
     just: it takes the h07 frame from 14.4 to 15.7 ms and the spare
     margin from 14 % of the budget to 6 %. This tier's promise is
     60 fps on a GTX 1660 that was never measured, msaa is a FIXED
     cost baked in at boot rather than something the governor climbs
     to on that machine's own evidence, and the block above already
     refused ratio 1.4 for leaving 2 %. Six per cent is not a margin
     either. So: rejected, on the margin rather than on the image —
     and if that margin is ever revisited, msaa 4 is now the measured
     best buyer of the marginal millisecond, because ratio 1.4 at
     msaa 2 does not fit inside 16.67 ms at all.

     AND THE GRAIN THAT WAS SWITCHED OFF IS WHERE _k27-ref's 1.52
     FREEZE PROOF CAME FROM. Re-run with it on: the null stops being
     zero and becomes sE 1.38 / cA 1.95 / cH 3.38 — a quarter of the
     signal, injected by a random field that is not aliasing — while
     every ratio lands within 0.6 % of its grain-off value (pr1/ms4
     1.155x, msaa0 1.093x, msaa4 0.954x, pr1.5 0.868x). So turning it
     off bought resolution and changed no conclusion, which is what a
     control is for.

     THE HOUR IS NOT A CONFOUND, which was worth checking because the
     cost table above is taken at h07 for a reason — that is the hour
     with the long shadows, and a shadow edge crawls like any other.
     The roofline pan re-run at h07 (same rig, same page-load rule):
     pr1/ms4 1.129x, msaa0 1.080x, msaa4 0.945x, pr1.5 0.872x —
     every conclusion above, within 3 % of its h12.5 value.

     THE INSTRUMENT'S BIAS. The reference crawls a little itself, and
     a sharper candidate's crawl correlates with the reference's more
     than a blurry one's does, so some of the reference's own crawl
     subtracts out of the sharp rows and not the soft ones. That
     flatters RESOLUTION — the conservative direction for every
     conclusion here except the drift flip, which is therefore at
     least as large as it reads.

     AND THIS TIER IS NOW CHEAPER TO BOOT THAN IT WAS. pixelRatio
     stays 1, so the first frame is 11.32 ms where it used to be 11.84;
     everything above that is climbed to by the governor in renderer.js
     on THIS device's evidence of missed frames, and a notch that
     fails is locked out for the session. `high` is handed to a GTX
     1660 as well as an M1 Max, and the 1660 was never measured — so
     the change that matters for it is that the frame it boots into got
     cheaper, and it simply never lifts. */
  high: {
    name: 'high',
    pixelRatio: 1, pixelRatioMax: 1.5, pixelBudget: 2.30,
    shadowCascades: 2, shadowSize: 1792, shadowSoft: true,
    ssao: true, bloom: true, bloomMips: 4, dof: true,
    outline: true, grain: true, grass: 1.35, grassDist: 68,
    waterReflect: true, particles: 1.0, anisotropy: 8, msaa: 2,
  },
  /* OPT-IN ONLY — see pickQuality. Nothing this project has been
     measured on holds 60 fps here, so nothing is handed it
     automatically. It is what you switch on for a screenshot, or on
     hardware faster than anything tested.

     WHICH IS THE WHOLE REASON IT KEEPS MSAA 4 AND TAKES RATIO 2 AS
     WELL. This tier has no frame-time promise to trade against, so it
     is the one place the trade above does not apply: it should simply
     buy the best image measured, and pr 2 + msaa 4 is it — RMSE 3.503
     against ground truth, half the error of the frame `high` shipped,
     for 39.76 ms and about 25 fps. Budget 6.00 Mpx puts the ceiling at
     2.04 in a 1600x900 box and still self-limits a 4K one to 1. */
  ultra: {
    name: 'ultra',
    pixelRatio: 1, pixelRatioMax: 2, pixelBudget: 6.00,
    shadowCascades: 3, shadowSize: 2048, shadowSoft: true,
    ssao: true, bloom: true, bloomMips: 5, dof: true,
    outline: true, grain: true, grass: 1.40, grassDist: 110,
    waterReflect: true, particles: 1.4, anisotropy: 16, msaa: 4,
  },
};

/* THE NAME OF A TIER, WITHOUT ITS PARENTHESIS — and why this is not a
   convenience.

   pickQuality labels the software-rasteriser tier 'med(sw)': a real
   `med` in everything but its pixel ratio, which is pinned to 1. So
   `q.name === 'med'` is FALSE on it, and every test written that way
   drops it into the ELSE branch — which is the branch written for the
   fastest hardware in the table. Both of the sites this file could
   reach were doing exactly that: city.js handed a software rasteriser
   56 cloths (the `high` count, against med's 40) and audio.js gave it
   full music detail. Eight modules had each written their own private
   copy of this one line; this is the copy they now share.

   An unrecognised name collapses to 'high' rather than throwing,
   because every caller uses the result as a table key and a missing
   key must never be the thing that stops a frame. */
export function tierName(n) {
  const s = String(n ?? '').replace(/\(.*$/, '').trim();
  return Object.hasOwn(QUALITY_TIERS, s) ? s : 'high';
}

/* ------------------------------------------------------------
   THE SETTINGS MENU'S TIER PIN.

   A tier cannot be re-applied live — cascades, grass, crowd, clouds,
   cloth, MSAA and bloom are all built at init, across seven modules —
   so the menu reloads the page with ?quality=<tier> (see menus.js).
   The URL carries the choice across that one reload; this carries it
   across the NEXT one, when the player opens the game again from a
   bookmark with no query on it.

   IT IS NOT IN THE SAVE, and that is not laziness: pickQuality runs
   inside createContext, before game/save.js has read a byte, and
   save.js deletes any settings key that is not in DEFAULT_SETTINGS.
   Per-device is also the right scope — the tier is a fact about the
   machine, not about the playthrough.

   `?shot` runs ignore the pin outright. A capture rig must render the
   tier the probe or the query string names, never one a human left
   behind in that browser profile.
   ------------------------------------------------------------ */
const PIN_KEY = 'wally.quality.v1';

/** The pinned tier name, or null when the player has not pinned one. */
export function qualityPin(env) {
  const g = env || (typeof globalThis !== 'undefined' ? globalThis : {});
  let v = null;
  try { v = g.localStorage?.getItem(PIN_KEY) || null; }
  catch (e) { return null; }            // private mode, or file:// with storage off
  return v && Object.hasOwn(QUALITY_TIERS, v) ? v : null;
}

/** Pin a tier for this device, or clear the pin with null. Returns it. */
export function pinQuality(tier, env) {
  const g = env || (typeof globalThis !== 'undefined' ? globalThis : {});
  const ok = tier && Object.hasOwn(QUALITY_TIERS, tier) ? tier : null;
  try {
    if (ok) g.localStorage?.setItem(PIN_KEY, ok);
    else g.localStorage?.removeItem(PIN_KEY);
  } catch (e) { /* the reload's own ?quality= still carries this session */ }
  return ok;
}

/* ============================================================
   WHAT KIND OF DEVICE IS THIS?

   pickQuality() used to read UNMASKED_RENDERER_WEBGL and nothing else
   — no viewport, no devicePixelRatio, no user agent, no touch. Driven
   down each branch with the real function (tools/_fa-tier.mjs), that
   meant:

     'Apple GPU' (every iPhone/iPad on Safari 15+)  -> med
     the withheld-extension case (name === '')      -> med
     Adreno 740 / Mali-G715 / Adreno 640            -> med
     'Apple M2' (an M-series iPad)                  -> HIGH, msaa 4 + DOF
     'Intel Iris Xe'                                -> low

   Two things are wrong there and they are opposite errors. A phone
   reached `med` by falling off the end of a list of DESKTOP GPU names
   — no phone string was ever written for it, so the tier a handset got
   was an accident that happened to be defensible. And `low`, whose own
   comment says "Integrated graphics and phones", was reachable ONLY by
   an Intel laptop. Meanwhile an iPad matched /apple m[1-9]/ by string
   coincidence and was handed a tier tuned on an M1 Max: an M2's GPU is
   roughly a third of an M1 Max's, and high was retuned until it JUST
   held 60 fps at 1600x900 on the M1 Max, so that promise cannot
   survive the trip. (An estimate from published throughput, not a
   measurement — nobody here has an iPad. It is enough to say `high` is
   not a tier to hand out by accident.)

   THE AXIS THAT ACTUALLY SEPARATES THESE IS NOT THE GPU NAME, IT IS
   WHAT THE DEVICE *IS*, and every input needed was already available:

     phone    touch-capable AND (the UA says mobile OR the short edge
              of the CSS viewport is <= 500 px)
     tablet   touch-capable, big box: iPad, Android tablet, Surface,
              and a touchscreen laptop
     desktop  no touch at all, whatever the window size — a narrow
              desktop window is still a desktop, which is what keeps
              every 390x844 measurement rig on this project honest
              about which branch it is exercising

   `screen` is only consulted when there is no layout viewport to read;
   innerWidth/innerHeight is the box the game is actually drawn into.
   Everything is read through globalThis and guarded, so this module
   still imports cleanly in plain node (src/game/* depends on that) and
   tools can drive it with a stub environment. */
export function deviceClass(env) {
  const g = env || (typeof globalThis !== 'undefined' ? globalThis : {});
  const nav = g.navigator || {};
  const touch = ((nav.maxTouchPoints | 0) > 0) || ('ontouchstart' in g);
  if (!touch) return 'desktop';

  const uad = nav.userAgentData;
  let mobileUA;
  if (uad && typeof uad.mobile === 'boolean') mobileUA = uad.mobile;
  else mobileUA = /android.*mobile|iphone|ipod|windows phone|iemobile|mobile safari/i
    .test(String(nav.userAgent || ''));

  const scr = g.screen || {};
  const w = Math.max(1, Math.round(g.innerWidth || scr.width || 1024));
  const h = Math.max(1, Math.round(g.innerHeight || scr.height || 768));
  const shortEdge = Math.min(w, h);

  /* 500 px: a 430x932 iPhone 16 Pro Max is the widest handset in CSS
     px; the narrowest tablet box in portrait is a 768-wide iPad mini. */
  if (mobileUA || shortEdge <= 500) return 'phone';
  return 'tablet';
}

/* Old handset silicon. THIS LIST CAN ONLY DEMOTE — a phone whose GPU
   it does not recognise gets exactly the tier a phone gets today, so
   an unknown device is never worse off than it was before this
   function learned what a phone is. Adreno 3xx-5xx, the Mali T series,
   PowerVR, and Apple A11 and older are all pre-2018 parts. */
const OLD_MOBILE_GPU = /adreno\s*(\(tm\)\s*)?[1-5]\d\d\b|mali-t|powervr|videocore|apple a([4-9]|10|11)\b/i;
/* Discrete desktop parts. Consulted only to PROMOTE a handheld class
   back to the desktop branch: a Windows laptop with a touchscreen and
   an RTX is a desktop that happens to accept fingers, and must not
   lose `high` to a device-class test — including when its window has
   been dragged narrow enough that the short-edge rule calls it a
   phone. No handset has ever reported one of these strings, so the
   escape costs nothing on a real phone. Apple silicon is deliberately
   NOT here: an M-series part behind a touchscreen is an iPad, which is
   the exact string coincidence this is fixing. */
const DESKTOP_DISCRETE = /geforce|\brtx\b|\bgtx\b|quadro|radeon (rx|pro)|\barc\b/i;

/* THE PARTS THAT ARE ACTUALLY FAST — the `high` promise, which is a
   frame time, so this list is FAMILIES WITH A GENERATION NUMBER and
   never a bare vendor word.

   THE BUG IT REPLACES: a GTX 1650 (matched by `geforce gtx 1[6-9]`)
   got `high`, and a Radeon RX 7900 XTX — some fifteen times its
   throughput, and the fastest consumer card AMD sells — got `med`,
   because no AMD consumer string was on the list at all. Every
   Radeon that was not a `radeon pro` workstation part fell off the
   end of the desktop branch, and so did every GeForce older than the
   16 series, GTX 1080 included.

   DESKTOP_DISCRETE IS DELIBERATELY NOT REUSED HERE. It exists to
   answer a different question — "is this touchscreen thing really a
   desktop?" — and it answers it with `/geforce/`, `/\bgtx\b/` and
   `/radeon rx/`, which are true of a GT 710 and an RX 550. Promoting
   on that list would hand `high` to parts that cannot hold 30 fps.

   The four families, and what each one's slowest member is:
     geforce rtx / rtx      RTX 3050, ~GTX 1660 Super
     geforce gtx 1[6-9]xx   GTX 1650              (already here)
     gtx 10[6-8]0           GTX 1060, faster than the 1650
     radeon rx 6-9 xxx      RX 6400, ~GTX 1650    (RDNA2 and newer)
     arc a/b xxx            Arc A380, ~GTX 1650
     apple m[1-9]           M1                    (already here)

   The Arc entry has to come BEFORE the `/intel|uhd|iris/` demotion
   below or it never fires: an Arc reports as
   "Intel(R) Arc(TM) A770 Graphics", the vendor test matches on
   'intel', and the fastest GPU Intel makes lands on `low` next to a
   UHD 620. It also has to tolerate the "(TM)" that sits between the
   family and the model number — `\barc a\d` does not, which is why
   DESKTOP_DISCRETE never promoted an Arc tablet either (fixed above).
   `arc\s*(\(tm\)\s*)?[ab]\d{3}` requires the model number, so the
   Meteor Lake / Lunar Lake integrated parts branded plain "Intel Arc
   Graphics" and "Intel Arc 140V" do NOT match and keep `low`. */
const FAST_GPU = new RegExp([
  'apple m[1-9]',
  'radeon pro',
  'geforce rtx', 'rtx',
  'geforce gtx 1[6-9]', 'gtx 10[6-8]0',
  'radeon\\s+rx\\s*[6-9]\\d{3}', '\\brx\\s*[6-9]\\d{3}\\b',
  'arc\\s*(\\(tm\\)\\s*)?[ab]\\d{3}',
].join('|'), 'i');

/* Probe the device and the GPU and pick a starting tier.

   THIS USED TO HAND AN M1 MAX 'ultra', WHICH MEASURED 46 fps. A probe
   that names a tier the hardware cannot run is worse than no probe:
   the player never sees the frame rate the game was designed at and
   has no reason to suspect a setting is responsible. The fast-GPU
   branch now returns 'high' — retuned above until it genuinely held
   60 fps in the heaviest scene — and 'ultra' is never PROBED for: it
   is reachable only by asking for it, through ?quality=ultra or the
   Quality row in Settings, which pins a tier and reloads.

   Headless SwiftShader reports as a software renderer and gets 'med':
   the old code gave it 'high' for "correct visuals", but every visual
   law in ART_DIRECTION is a colour and a shape law, not a shadow
   cascade count, and a screenshot that takes four seconds a frame to
   capture is its own kind of wrong. It is also the ONE tier that is
   pinned to pixelRatio 1: a software rasteriser is nothing but pixel
   cost, so the governor has nothing to find there.

   ITS NAME IS 'med(sw)', AND THAT PARENTHESIS IS A TRAP FOR EVERY
   CONSUMER OF ctx.quality.name. `name === 'med'` is false on it, so a
   two-armed test hands the slowest renderer in the project the arm
   written for the fastest. Compare through tierName(q.name), never
   against the raw string.

   ORDER MATTERS, and it is:
   forced -> pinned -> software -> handheld -> desktop.
   The software check stays first of the probes because a software
   rasteriser is the binding constraint no matter what shape the
   window is; the handheld checks come before the GPU-name list
   because that list is a list of DESKTOP parts and a phone reaching
   it at all was the bug. The player's own pin outranks every probe
   and is outranked only by the query string — a rig must always be
   able to name the tier it is capturing. */
export function pickQuality(renderer, env) {
  const g = env || (typeof globalThis !== 'undefined' ? globalThis : {});
  const qs = new URLSearchParams((g.location && g.location.search) || '');
  /* `?msaa=N` overrides the tier's own multisample count on any tier,
     including a forced one. It is how the A/B in renderer.js was
     taken: one boot per value, same framing, same clock. */
  const msaaOverride = qs.has('msaa') ? Math.max(0, Math.min(8, +qs.get('msaa') | 0)) : null;
  const withMsaa = (t) => (msaaOverride == null ? t : { ...t, msaa: msaaOverride });

  /* Object.hasOwn, NOT a truthiness test on the lookup. `?quality=
     constructor` (or toString, or valueOf, or __proto__) found a
     PROTOTYPE member, spread a function into the tier, and returned an
     object with no `name`, no `pixelRatio` and no `shadowSize`.
     renderer.js then threw inside init, so ctx.render stayed null —
     while main.js went on to publish __WALLY_READY__ true and the HUD
     drew over an empty frame. Player-unreachable, but it is exactly
     the shape of failure a harness reports as a passing boot. */
  const forced = qs.get('quality');
  if (forced && Object.hasOwn(QUALITY_TIERS, forced)) {
    return withMsaa({ ...QUALITY_TIERS[forced] });
  }

  /* The Settings menu's pin (see qualityPin above). Never on a `?shot`
     run: a capture must render the tier its command line asked for. */
  if (!qs.has('shot')) {
    const pinned = qualityPin(g);
    if (pinned) return withMsaa({ ...QUALITY_TIERS[pinned] });
  }

  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') || '';
  const soft = /swiftshader|llvmpipe|software|webkit webgl/i.test(name);

  if (soft) return withMsaa({ ...QUALITY_TIERS.med, name: 'med(sw)', pixelRatioMax: 1 });

  const cls = deviceClass(g);
  if (cls === 'phone' || cls === 'tablet') {
    if (OLD_MOBILE_GPU.test(name)) return withMsaa({ ...QUALITY_TIERS.low });
    /* A Windows tablet on integrated Intel is the same machine the
       desktop branch already sends to `low` — but the vendor word is
       'Intel' on a discrete Arc too, and this test used to be the
       reason the fastest GPU Intel makes landed on `low` next to a
       UHD 620. The exemption is the fast list, not the word 'arc':
       the integrated parts branded "Intel Arc Graphics" and "Intel
       Arc 140V" carry no model number, fail FAST_GPU, and keep `low`
       exactly as they did. */
    if (/intel|uhd|iris/i.test(name) && !FAST_GPU.test(name)) return withMsaa({ ...QUALITY_TIERS.low });
    /* A touchscreen laptop with a real discrete GPU falls through to
       the desktop branch below, at any window size. Everything else
       handheld gets `med`, which is what a phone gets today — no
       frame-time promise moves here, only the pixels it renders them
       at (see pixelBudget). */
    if (!DESKTOP_DISCRETE.test(name)) return withMsaa({ ...QUALITY_TIERS.med });
  }

  if (FAST_GPU.test(name)) return withMsaa({ ...QUALITY_TIERS.high });
  if (/intel|uhd|iris/i.test(name)) return withMsaa({ ...QUALITY_TIERS.low });
  return withMsaa({ ...QUALITY_TIERS.med });
}

/* The context. Created once in main.js and threaded through every init. */
export function createContext({ canvas, renderer, scene, camera }) {
  const params = new URLSearchParams(location.search);

  const ctx = {
    THREE,
    canvas, renderer, scene, camera,

    bus: createBus(),
    clock: new THREE.Clock(),
    quality: pickQuality(renderer),

    /* Set by main.js each frame. Read-only for subsystems. */
    dt: 0,
    elapsed: 0,
    frame: 0,

    /* Boot flags from the query string. */
    flags: {
      shot: params.has('shot'),            // headless screenshot run
      scene: params.get('scene') || null,  // jump straight to a scene
      skipIntro: params.has('skipIntro') || params.has('shot'),
      debug: params.has('debug'),
      pose: params.get('pose') || null,
      hour: params.has('hour') ? +params.get('hour') : null,
    },

    /* Namespaces — each filled by its owning module (see OWNERSHIP). */
    render: null, mat: null, wind: null, sky: null,
    world: null, water: null, wally: null, phys: null,
    cam: null, game: null, ui: null, intro: null, audio: null,

    /* Subsystems that want a frame callback are collected here by main. */
    _handles: [],
  };

  /* Deterministic RNG so the world generates identically every run —
     screenshots must be comparable between builds. */
  ctx.rng = mulberry32(0x5eed1e);
  ctx.makeRng = (seed) => mulberry32(typeof seed === 'string' ? hashStr(seed) : seed);

  return ctx;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* Small maths helpers everyone needs. Import from here, don't re-declare. */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (v - a) / (b - a);
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/* Frame-rate independent exponential smoothing. Use this instead of
   `a = lerp(a, b, 0.1)` — that one is a physics bug at variable dt. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/* Critically damped spring — the camera, ears and trunk all use this.
   Returns [newValue, newVelocity]. */
export function spring(value, velocity, target, stiffness, damping, dt) {
  const f = (target - value) * stiffness - velocity * damping;
  const v = velocity + f * dt;
  return [value + v * dt, v];
}
