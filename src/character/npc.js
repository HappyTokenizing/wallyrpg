/* ============================================================
   npc.js — ctx.npc. The population of Bull Bear City.

   The island had streets, shops, a stadium and a harbour and not one
   person on it, which is the difference between a town and a model of
   a town. This module puts people in it:

     * the 24 named clients from src/game/data.js, each generated from
       their own appearance row so Mabel is recognisably Mabel, standing
       at their home district and approachable;
     * an ambient crowd walking the real road network, thinning out at
       night and thickening at lunchtime, stopping at whatever is open.

   Everything visible here is built by src/character/humans.js — one
   ctx.mat.clay() material for the whole population, one shared body
   mesh, per-character colour. See that file's header for why.

   WHAT THIS FILE OWNS AND WHAT IT DOES NOT
   ----------------------------------------
   It owns spawning, placement, level of detail, the approach prompt and
   the debug cameras. It owns no geometry and no motion: humans.js makes
   the bodies, crowd.js moves them. Wally's own rig (wally.js, model.js,
   rig.js, anim.js, secondary.js, expression.js) is read here and never
   written — the NPC skeleton is a separate, much smaller rig, because a
   33-bone elephant is the wrong shape and the wrong cost for a crowd.

   LEVEL OF DETAIL. A skinned mesh costs its skeleton update whether you
   look at it or not, so every frame the module sorts the population by
   distance and only the nearest `budget` inside the camera frustum get
   their bones written; the rest keep walking (the city must not freeze
   behind you) but hold their pose. Beyond `FAR` they are hidden
   outright and the fog has already taken them.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { clamp, damp, smoothstep } from '../core/contracts.js';
import { CLIENTS, CLIENT_BY_ID, LOCATIONS, ZONES, RACE, AIRVIEW } from '../game/data.js';
import { createHumans, randomSpec, H as HUMAN_H } from './humans.js';
import { HumanAnim, createCrowd } from './crowd.js';
import { createBubbles, createLinePicker, ALL_LINES } from './bubbles.js';

/* Hidden past this. 150 m emptied a district the moment the camera
   pulled back to look at it — §2.4 hazes everything past 120 m, so a
   figure at 200 m is eight pixels of pale colour and costs two draw
   calls the frustum has already earned. Cutting them is a false
   economy that turns every vista back into a diorama. */
const FAR = 200;
const ANIM_FAR = 62;          // skeleton frozen past this
/* SHADOWS ARE PAID FOR PER CASCADE. A figure that casts into a
   4-cascade CSM is submitted five times, so 17 000 triangles of
   pedestrian is 85 000 triangles of work — and past twenty-odd metres
   the contact shadow it draws is a smudge two pixels wide that the
   §2.4 haze has already washed out. Beyond SHADOW_FAR they still
   RECEIVE (which is what keeps them sitting in the world) and stop
   casting, which is where most of the crowd's cost goes. */
const SHADOW_FAR = 24;
/* How far the skeleton reach may be stretched while the balloon is up.
   190 m is FAR minus the ten metres the thinning band needs: a person
   animated past the distance at which he is culled is a skeleton
   solved for a mesh nobody draws. The GAIN that gets there (3.4 m of
   reach per metre of lens height) is measured, not guessed: over Main
   Street the people actually inside the flight frame sit 105-140 m
   from the lens at every altitude from 12 m up, because the boom's
   pitch barely changes and the bottom edge of the picture walks
   outward with the camera. A gain of 1.9 reaches 104 m at 12 m of
   altitude and animated nobody at all. See the block above the LOD
   loop in update(). */
const ANIM_FLY_MAX = 190;
const THIN0 = 110;            // distance thinning starts
const THIN_MAX = 0.55;        // fraction dropped by FAR
const TALK_RANGE = 3.4;       // the approach prompt

/* ============================================================
   THE SKY CROWD — the draw cull, which is the actual bug.

   TWO ROUNDS RAISED THE WRONG NUMBERS. Round one aimed the look-at at
   the basket; round two made the ANIMATION reach follow the lens. Both
   were real, and neither could ever have worked, because ANIM_FLY_MAX
   (190) and the notice radius cap (190) are both UNDER `FAR` (200) —
   the draw cull. Measured over Market Hall at 13:00 on the real flight
   camera, at 80 m of altitude the six nearest people to the lens sit at
   NDC y = -3.65 to -5.04, four to five screen-heights below the bottom
   of the frame, and every person actually INSIDE the picture is past
   200 m. `h.root.visible = false` had already run. There was nobody to
   animate and nobody to notice with, and shots/judge2/fix-alt80-basket
   .png is a full city of streets and houses with not one human in it.
   The ladder said so in a column nobody assertted about: at 90 m,
   48 people project inside the frame and 0 are drawn.

   YOU CANNOT FIX IT BY RAISING FAR. AIRVIEW.max is 560 m; at cruise the
   player is looking at most of an island. Four hundred skinned meshes
   at 560 m of range is a diorama rendered as a city and it would cost
   what a city costs.

   SO ASK WHAT THE PLAYER CAN RESOLVE. Measured: a person is 75 px tall
   at 20 m of altitude, 21 px at 40 m, ~9 px at 90 m and 3-5 px past
   200 m. Nobody can see a head tilt at nine pixels. What a person CAN
   see at three pixels is a field of specks that MOVES — and then stops
   moving, all over the street, in a wave, because something is
   overhead. That is a much cheaper thing to draw than a face.

   So past AIR_NEAR the person stops being a skeleton and becomes one
   instance in a single billboard draw call: a silhouette in his own
   shirt colour, with the one cue that survives three pixels — the pale
   upturned face when he notices. The MOTION is free and already
   correct: crowd.js has always kept far agents walking (the `!a.active`
   branch steers and places them without touching a bone), and its
   `stare` makes an agent stop dead and turn, at zero skeleton cost.
   Nothing was ever wrong with the simulation. It was never drawn.

   NONE OF THIS TOUCHES THE GAME ON FOOT. Every number below is read
   only while ctx.wally.flying is true; on the ground the LOD loop takes
   the identical branches it always has and the sky crowd is not even
   built. It is built on the first lift-off and never at boot.
   ============================================================ */
/* Where a skinned pedestrian becomes an instanced silhouette. 150 m,
   because at 150 m from the flight lens a person is 11-12 px — under
   the size at which a body and a silhouette differ — and because it is
   inside `THIN0`'s band, so the people THINNING throws away come back
   as specks instead of as nothing. */
const AIR_NEAR = 150;
/* …and where he stops being drawn at all. AIRVIEW.max (560) is the
   game's own statement of how far you can see from up here; the boom
   sits 20-31 m behind the basket at every measured altitude, so the
   lens needs that much more than the basket does. */
const AIR_FAR = AIRVIEW.max + 60;          // 620
/* THE FLOOR UNDER A SPECK. A 1.68 m figure at 560 m is 1.9 px at this
   fov, and a sub-pixel quad does not dim, it FLICKERS — the crowd
   would boil. Below this the billboard is grown in world units to hold
   the floor, which trades a hair of scale error at the horizon (where
   a person is a dot either way) for a stable field.

   IT IS 4.2 PX AND NOT 2.6, AND THAT WAS MEASURED, NOT PREFERRED. At
   2.6 the crowd rendered and could not be FOUND: cropped at the exact
   pixel coordinates the ladder reported, a 5.8 px pedestrian on the
   Market Hall road read as dust on the lens — a soft alpha silhouette
   covering about 40 % of its own box, half-dissolved into a bright
   green ground by the blend. A person at 250 m of altitude is 2.5-3.4
   px, so the floor is what decides whether the top of the ladder has a
   crowd in it at all. Raising it costs a scale error only where a
   person is a dot either way. */
const AIR_MIN_PX = 5.0;
/* Aerial perspective, capped. wally.js's flyHaze already opens
   scene.fog to about 420/2392 at altitude, so at 600 m the honest
   linear fog factor is only ~0.24 and this cap almost never binds —
   but a three-pixel figure that is 95% haze is not a figure, and the
   one thing this feature may not do is dissolve the crowd it exists to
   draw. It binds only on a weather day with the fog shut down. */
const AIR_FOG_CAP = 0.86;

/* THE ROAD IS NOT THE TERRAIN. paths.js lays its ribbons at
   terrain.heightAt(x, z) + 0.09 so they read as a made surface rather
   than as a painted stripe, and ctx.world.heightAt — the only ground
   query on ctx — reports the terrain underneath. A 96 mm shoe grounded
   on the terrain while standing on a 90 mm ribbon is therefore buried
   to the laces: the review's single most obvious defect, "a pure-black
   hard-edged untextured sliver lying on the ground at the chef's feet",
   was the last 6 mm of a shoe sticking up through a road.
   distanceToRoad is 0.03 ms a call, so it is sampled once per stander
   and on a slow stagger per wanderer, never per frame per agent. */
const ROAD_LIFT = 0.09;
const ROAD_EDGE0 = 1.9, ROAD_EDGE1 = 2.7;

export async function init(ctx) {
  if (!ctx.mat || !ctx.world) {
    console.warn('[npc] needs ctx.mat and ctx.world');
    return { update() {} };
  }
  const t0 = performance.now();
  const q = ctx.quality || {};
  /* BOOT PROFILE — this stage was 8.4 s of a 13.9 s cold boot, so every
     phase of it is timed and the numbers live on ctx.npc.perf. */
  const P = { humans: 0, build: 0, wrap: 0, place: 0, clients: 0, planned: 0, total: 0 };
  const _tH = performance.now();
  const humans = createHumans(ctx);
  P.humans = performance.now() - _tH;

  const root = new THREE.Group();
  root.name = 'npc';
  ctx.scene.add(root);

  const all = [];                       // every human in the game
  const named = new Map();              // clientId -> human
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _sphere = new THREE.Sphere();
  const _still = { speed: 0, turn: 0 };
  const _frustum = new THREE.Frustum();
  const _mvp = new THREE.Matrix4();

  /* ------------------------------------------------------------
     Placement — where a person can actually stand.

     THE DOOR IS THE ANCHOR, NOT THE BUILDING. Sampling a ring around a
     location's centre puts a third of the population inside its walls,
     because the location's centre IS the building. ctx.city knows where
     each front door is, so the search runs over an arc in FRONT of the
     door — outward along the door normal, which by construction is the
     side the facade faces — and scores for standing about two metres
     off the road centre-line: close enough to be met, far enough not to
     be walked through.
     ------------------------------------------------------------ */
  /** How far the made surface stands above the terrain here. */
  function roadLift(x, z) {
    if (!ctx.world.distanceToRoad) return 0;
    return ROAD_LIFT * (1 - smoothstep(ROAD_EDGE0, ROAD_EDGE1, ctx.world.distanceToRoad(x, z)));
  }
  /** The height a pair of shoes should actually rest at. */
  function groundY(x, z) { return ctx.world.heightAt(x, z) + roadLift(x, z); }

  /* ------------------------------------------------------------------
     THE DOOR IS THE ANCHOR AND ALSO THE ONE PLACE NOBODY MAY STAND.

     "Barnaby and other NPCs are too close to some of the entrances to
     the buildings and interfere." The bug is in the two lines above
     this comment as they used to read: the search arc was ±1.25 rad
     centred on the door's OWN outward direction and the near radius was
     1.7 m, so the highest-scoring spot at a narrow frontage — near the
     road, off the slope, out from the centre — is very often the spot
     directly in front of the door at arm's length. ctx.city.doorPosition
     is documented as "the point you walk to", ui.js warps the player
     onto it and hud.js aims the compass at it, so a person standing
     there is standing inside the player and inside the camera that
     frames the entrance.

     THE FIX IS A SCORE, NOT A REJECTION. A hard exclusion zone would
     throw away every candidate at a location whose forecourt is only as
     wide as its door, and `best` would fall through to the fallback,
     which is the door itself — the bug, restored, with extra steps. A
     large penalty on being in the corridor plus a widened arc means the
     search STILL prefers the frontage (which is where a shopkeeper
     belongs) and takes the nearest patch of it that is not the
     threshold. Measured with ctx.npc.doorAudit().

     The volume is the same one crowd.js keeps its wanderers out of: a
     disc at the door and a corridor reaching out along the way the
     facade faces, wide enough for an elephant.
     ------------------------------------------------------------------ */
  /* ROUND 2, AND THE COMPLAINT CAME BACK: "the Barnaby NPC is still too
     close to the apartment where he interferes with easy access." It
     did, and the audit that was supposed to prove otherwise agreed with
     him — it just was not asked the right question.

     MEASURED BEFORE (ctx.npc.doorAudit + a per-client sweep over every
     door in the city, not only the client's own anchor):

       barnaby -> apartment      2.54 m   (along 0.51, side 2.49)
       nadia   -> harbourhomes   3.17 m
       bolt    -> devlab         3.56 m
       pearl   -> docks          3.59 m
       goldie  -> mineral        4.26 m   (side 0.03 — dead on the axis)

     `blocking` was empty for every one of them, and that was true:
     Barnaby is 2.49 m to the SIDE of the apartment door, which the old
     1.25 m half-corridor calls clear. It is not clear. He is level with
     the threshold, an elephant is wide, and the camera that frames the
     entrance has him in it. Goldie is the same defect from the other
     end — 4.26 m dead on the door's axis, past the old 3.60 m corridor
     and therefore invisible to the test, standing in the middle of the
     approach.

     So the volume grows to the size of the thing it is protecting: a
     3.20 m disc, and a corridor 5.60 m long and 2.30 m to a side, which
     is a lane an elephant can walk down without brushing anybody.

     AND IT IS SCORED AGAINST EVERY DOOR, NOT JUST THE ANCHOR'S. This is
     the actual bug behind Barnaby. He is planned against a location in
     Rusty Row and the apartment is its neighbour, so his own anchor's
     doorway was the only one the score ever looked at and the apartment
     door was, to the placer, not there. */
  /* THE TWO REGIMES, WRITTEN OUT. `before:true` in doorAudit re-plans
     the population under OLD in full — every constant of it, not a
     convenient subset — which is the only way the A/B can be a
     measurement instead of a claim.

     ROUND 3 CAUGHT THIS TOOL LYING. The mode used to flip `doorPenalty`
     and the arc alone while the search kept the NEW annulus
     (near 3.4 m), so "before" could not physically produce the 2.54 m
     spot the comment above reports, and both branches returned barnaby
     at 4.16 m — a coincidence of geometry, (0.83, 4.07) against
     (1.87, 3.71), which made the tool look consistent while proving
     nothing. OLD below is transcribed from git 87d195a
     src/character/npc.js lines 149-151 (the corridor), 190 (the arc)
     and 1926 (the client annulus). */
  const REGIME = {
    now: { r: 3.20, len: 5.60, half: 2.30, arc: 1.55, spot: { near: 3.4, far: 9.0, tries: 34 } },
    old: { r: 2.30, len: 3.60, half: 1.25, arc: 1.25, spot: { near: 2.0, far: 6.0 } },
  };
  let DOOR_CLEAR_R = REGIME.now.r;
  let DOOR_CLEAR_LEN = REGIME.now.len;
  let DOOR_CLEAR_HALF = REGIME.now.half;
  let SPOT_ARC = REGIME.now.arc;
  /* Switched OFF only by doorAudit({before:true}), which re-plans the
     whole population on the same seeds with the old arc and the old
     score so the fix can be reported as a number rather than as a
     claim. Nothing else touches it. */
  let doorPenalty = true;

  /** Run `fn` with the entire pre-fix placement regime installed, and
      hand it the old client annulus. The MEASUREMENT afterwards is
      deliberately not swapped: both branches are read with today's
      ruler, only the placement differs. */
  function withOldRegime(fn) {
    const R = REGIME.old, N = REGIME.now;
    DOOR_CLEAR_R = R.r; DOOR_CLEAR_LEN = R.len; DOOR_CLEAR_HALF = R.half;
    SPOT_ARC = R.arc; doorPenalty = false;
    try { return fn(R.spot); } finally {
      DOOR_CLEAR_R = N.r; DOOR_CLEAR_LEN = N.len; DOOR_CLEAR_HALF = N.half;
      SPOT_ARC = N.arc; doorPenalty = true;
    }
  }

  /* The before-figures quoted in the comment above, checked in so a
     later round can tell "the fix moved him" apart from "the tool
     changed". doorAudit() returns them as `expectBefore`, and
     doorAudit({before:true}) re-derives them and reports `matches`.

     AS OF ROUND 3 THE REPLAY REPRODUCES barnaby 2.54, pearl 3.59 and
     goldie 4.26 to the centimetre; nadia comes back 4.69 (was 3.17) and
     bolt 5.41 (was 3.56). Those two are drift in the WORLD, not in this
     tool: a standing spot is scored against ctx.world.heightAt /
     slopeAt / distanceToRoad and ctx.city.doorPosition, and city.js has
     moved ~500 lines since the figures were taken, harbourhomes and
     devlab among them. Both still resolve to the same door as quoted.
     Left as recorded rather than re-baselined to today's world — a
     fixture that is edited whenever it disagrees is not a fixture. */
  const BEFORE_FIXTURE = {
    barnaby: { door: 'apartment', metres: 2.54 },
    nadia: { door: 'harbourhomes', metres: 3.17 },
    bolt: { door: 'devlab', metres: 3.56 },
    pearl: { door: 'docks', metres: 3.59 },
    goldie: { door: 'mineral', metres: 4.26 },
  };

  /** 0 = clear of every doorway, 1 = standing in one. */
  function doorClearance(x, z, dx, dz, ax, az) {
    const ox = x - dx, oz = z - dz;
    const along = ox * ax + oz * az;
    const side = ox * az - oz * ax;
    let k = 0;
    if (along > -0.8 && along < DOOR_CLEAR_LEN && Math.abs(side) < DOOR_CLEAR_HALF) {
      k = 1 - Math.abs(side) / DOOR_CLEAR_HALF;
    }
    const r = Math.hypot(ox, oz);
    if (r < DOOR_CLEAR_R) k = Math.max(k, 1 - r / DOOR_CLEAR_R);
    return k;
  }

  /** The worst doorway this point is in the way of — ANY doorway. */
  function doorClearanceAny(x, z, list) {
    let k = 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      const c = doorClearance(x, z, d.x, d.z, d.ax, d.az);
      if (c > k) { k = c; if (k >= 1) break; }
    }
    return k;
  }

  /* Named clients are permanent furniture — they never wander off the
     spot the placer gave them — so their annulus starts OUTSIDE the
     keep-clear disc rather than inside it (2.0 -> 3.4 m) and reaches
     further round the frontage for somewhere to put them. It lives in
     REGIME so that the A/B swaps the annulus along with everything
     else instead of comparing two different searches. */
  const CLIENT_SPOT = REGIME.now.spot;

  const _door = new THREE.Vector3();
  function standingSpot(loc, rng, opts = {}) {
    const _tp = performance.now();
    const want = opts.want ?? 2.1;
    const cx = loc.world.x, cz = loc.world.z;
    let ax = cx, az = cz, outA = rng() * Math.PI * 2, arc = Math.PI;
    /* the door's outward normal, when there is a door */
    let hasDoor = false, nx = 0, nz = 0;
    const d = ctx.city?.doorPosition?.(loc.id, _door);
    if (d && Number.isFinite(d.x)) {
      ax = d.x; az = d.z;
      const ox = ax - cx, oz = az - cz;
      const ol = Math.hypot(ox, oz);
      if (ol > 0.4) {
        outA = Math.atan2(ox, oz);
        /* 1.25 -> 1.55 rad. The corridor penalty below rules out the
           middle of this arc, so the arc has to reach far enough round
           the frontage to have somewhere left to put anybody. */
        arc = SPOT_ARC;
        hasDoor = true; nx = ox / ol; nz = oz / ol;
      }
    }
    const near = opts.near ?? 1.7;
    const far = opts.far ?? Math.max(near + 1.4, Math.min(7, (loc.radius || 9) * 0.7));
    /* EVERY DOORWAY THIS SEARCH CAN REACH, not just the anchor's. Built
       once per call and prefiltered by range, so the inner loop is over
       one or two doors and the whole population still plans in the same
       boot budget: at 28 doors the naive form is 300k clearance tests. */
    const reach = far + DOOR_CLEAR_LEN + 1;
    const nearDoors = [];
    if (doorPenalty) {
      for (let i = 0; i < DOORS.length; i++) {
        const q = DOORS[i];
        if ((q.x - ax) * (q.x - ax) + (q.z - az) * (q.z - az) < reach * reach) nearDoors.push(q);
      }
    }
    let best = null, bestScore = -1e9;
    const tries = opts.tries ?? 26;
    for (let i = 0; i < tries; i++) {
      const a = outA + (rng() - 0.5) * 2 * arc;
      const r = near + rng() * (far - near);
      const x = ax + Math.sin(a) * r, z = az + Math.cos(a) * r;
      const y = ctx.world.heightAt(x, z);
      if (y <= (ctx.world.seaLevel ?? 0) + 0.35) continue;
      const slope = ctx.world.slopeAt ? ctx.world.slopeAt(x, z) : 0;
      const dRoad = ctx.world.distanceToRoad ? ctx.world.distanceToRoad(x, z) : want;
      /* pushing OUT from the location centre is what keeps people out
         of the shop they are standing in front of.
         WANTING THE ROAD MATTERS MORE THE FURTHER OUT YOU LOOK: at a
         `far` of 8 m every sample is on the forecourt anyway, but a
         plaza search reaching 26 m will happily place someone inside the
         building next door unless being near a made surface dominates
         the score. Roads are, by construction, the ground nothing is
         built on. */
      const outward = Math.hypot(x - cx, z - cz);
      const roadW = far > 12 ? 3.2 : 1.8;
      let score = -Math.abs(dRoad - want) * roadW - slope * 7 + outward * 0.22;
      /* THE DOORWAY PENALTY. 26 is deliberately larger than anything
         else in this expression can produce: being on the doorstep has
         to lose to every legal spot on the frontage, not merely to the
         good ones. It is a ramp rather than a cliff so that a location
         with no clear frontage at all still degrades gracefully — it
         takes the least-bad spot instead of the fallback. */
      if (doorPenalty && nearDoors.length) score -= doorClearanceAny(x, z, nearDoors) * 26;
      else if (hasDoor && doorPenalty) score -= doorClearance(x, z, ax, az, nx, nz) * 26;
      if (score > bestScore) { bestScore = score; best = { x, y, z, a }; }
    }
    /* THE FALLBACK MAY NOT BE THE DOOR ITSELF. Nothing scored, so put
       them a stride to one side of the threshold rather than in it. */
    if (!best) {
      const s = rng() < 0.5 ? 1 : -1;
      const sx = ax + (hasDoor ? nz * s * DOOR_CLEAR_HALF + nx * 1.2 : 0);
      const sz = az - (hasDoor ? nx * s * DOOR_CLEAR_HALF - nz * 1.2 : 0);
      best = { x: sx, y: ctx.world.heightAt(sx, sz), z: sz, a: outA };
    }
    best.y = groundY(best.x, best.z);
    /* face away from the building — nobody stands looking at a wall */
    best.yaw = Math.atan2(best.x - cx, best.z - cz) + (rng() - 0.5) * 0.9;
    P.place += performance.now() - _tp;
    return best;
  }

  /* ------------------------------------------------------------
     Build one person
     ------------------------------------------------------------ */
  function makeHuman(spec, seed, detail) {
    let _t = performance.now();
    const h = humans.build(spec, seed, detail);
    P.build += performance.now() - _t; _t = performance.now();
    h.anim = new HumanAnim(h, ctx.makeRng(seed || ('anim.' + spec.id)));
    h.id = spec.id;
    h.name = spec.n || '';
    h.client = CLIENT_BY_ID[spec.id] || null;
    h.active = true;
    h.asleep = false;
    h.dist = 0;
    h.lookW = 0;
    h.sayT = 0;
    h.baseYaw = 0;
    h.baseMode = 'idle';
    /* stable per-person key for distance thinning — never re-rolled, so
       a figure cannot flicker in and out as the camera breathes */
    h.lodKey = ctx.makeRng('lod.' + (spec.id || all.length))();
    h.lookVec = new THREE.Vector3();
    root.add(h.root);
    ctx.mat.register(h.root, { noOutline: true, castShadow: true, receiveShadow: true });
    all.push(h);
    P.wrap += performance.now() - _t;
    return h;
  }

  /* ============================================================
     PLACEMENT IS CHEAP, MESHING IS NOT. SO PLACE EVERYONE AND MESH
     NOBODY UNTIL IT IS WORTH IT.

     Deciding where four hundred people stand costs 134 ms; turning them
     into geometry cost eight seconds, and it was the whole of the wait
     before the game could be played. Nothing about a figure's identity
     — who they are, where they stand, which way they face, what they
     are doing — needs a mesh, so every one of them is *planned* during
     boot and the plan is a `Rec`: a spec, a seed, a detail tier and a
     spot on the island. Boot then meshes only the named clients close
     enough to be seen from the start, and the streamer below turns the
     rest into people over the first second or so of play, nearest to
     the camera first, on a per-frame time budget.

     Two things make this safe rather than merely fast. Records are
     planned in exactly the order the old code built them, drawing on
     exactly the same seeded streams, so every person comes out
     identical to before — same face, same clothes, same spot. And the
     build radius is a distance, never a timer, so two runs of the same
     build populate the same world in the same order and a screenshot is
     still reproducible.
     ============================================================ */
  const pending = [];          // planned, not yet meshed
  let planIndex = 0;

  /** Turn one planned record into an actual person in the scene. */
  function buildRec(r) {
    if (r.built) return r.built;
    const h = makeHuman(r.spec, r.seed, r.detail);
    r.built = h;
    h.rec = r;
    h.root.position.set(r.x, r.y, r.z);
    h.baseYaw = r.yaw;
    h.root.rotation.y = r.yaw;
    h.home = new THREE.Vector3(r.x, r.y, r.z);
    h.homeLoc = r.homeLoc || null;
    h.baseMode = r.mode;
    h.anim.setMode(r.mode);
    if (r.kind === 'client') {
      h.isClient = true;
      named.set(r.id, h);
    } else if (r.kind === 'wander') {
      const a = crowd.add(h);
      if (!a) { h.dispose(); all.pop(); r.built = null; r.dead = true; return null; }
      h.agent = a;
    }
    return h;
  }

  /** Drop a record from the queue once it has been built. */
  function takeRec(r) {
    const i = pending.indexOf(r);
    if (i >= 0) pending.splice(i, 1);
    return buildRec(r);
  }

  /* ------------------------------------------------------------
     The 24 named clients
     ------------------------------------------------------------ */
  function planClient(id, pos) {
    const c = CLIENT_BY_ID[id];
    if (!c) { console.warn(`[npc] no client "${id}"`); return null; }
    const rng = ctx.makeRng('npc.place.' + id);
    /* their appearance row IS the spec — every field of it is used */
    const spec = {
      id: c.id, n: c.n, role: c.role,
      skin: c.skin, face: c.face, hair: c.hair, hairCol: c.hairCol,
      beard: c.beard, specs: c.specs, hat: c.hat, hue: c.hue,
      age: c.age | 0, mood: c.mood || '',
      build: 0.92 + rng() * 0.20 + (c.age === 2 ? 0.04 : 0),
      stature: (c.age === 2 ? 0.955 : 0.98) + rng() * 0.075,
    };
    /* MAYOR KEN JONES IS A LIKENESS, not a row of data fields — see the
       MAYOR_LOOK block below for what is being overridden and why. It is
       applied AFTER the build/stature draws above so that his height is
       his and not the dice's, and it consumes no rng of its own, so
       every other client on the island comes out identical. */
    if (id === MAYOR_ID) Object.assign(spec, MAYOR_LOOK);
    let p = pos, homeLoc = null, yaw;
    if (!p) {
      /* their home is a district; stand them by a location inside it */
      const locs = LOCATIONS.filter((l) => l.z === c.home);
      const z = ZONES[c.home];
      const anchor = locs.length
        ? locs[Math.floor(rng() * locs.length) % locs.length]
        : null;
      const ref = anchor || { id: null, world: { x: z ? z.world.x : 0, z: z ? z.world.z : 0 }, radius: 16 };
      p = standingSpot(ref, rng, CLIENT_SPOT);
      homeLoc = anchor ? anchor.id : null;
      yaw = p.yaw;
    } else {
      p = { x: p.x, y: p.y ?? groundY(p.x, p.z), z: p.z };
      yaw = rng() * Math.PI * 2;
    }
    /* a shopkeeper works, a customer waits, a coach stands and glares */
    const mode = c.role && /owner|barista|driver|dispatcher|engineer|researcher|artist/i.test(c.role)
      ? (rng() < 0.5 ? 'work' : 'idle') : 'idle';
    /* Named clients are the only people the camera ever frames from a
       metre away, so they are the only ones that get the fine mesh. */
    const r = {
      kind: 'client', id, spec, seed: 'client.' + id, detail: 'fine',
      x: p.x, y: p.y, z: p.z, yaw, mode, homeLoc, order: planIndex++,
    };
    pending.push(r);
    return r;
  }

  /** Build a named client now, wherever they are. */
  function spawnClient(id, pos) {
    if (named.has(id)) return named.get(id);
    const r = pending.find((q) => q.kind === 'client' && q.id === id)
      || planClient(id, pos);
    return r ? takeRec(r) : null;
  }

  /* ASKING FOR SOMEBODY IS A REASON TO BUILD THEM. Every path that
     reaches for a client by name — the dialogue, the debug cameras, the
     lineup — goes through here, so a client who is still in the queue is
     meshed on the spot instead of coming back null. Nothing else has to
     know the queue exists. */
  function ensure(id) {
    return named.get(id) || spawnClient(id) || all.find((x) => x.id === id) || null;
  }

  /* ------------------------------------------------------------
     The ambient crowd
     ------------------------------------------------------------ */
  /* EVERY DOOR IN THE CITY, ONCE, AS A POINT AND A FACING. crowd.js
     needs this to keep its wanderers out of the thresholds and it has no
     business reaching for ctx.city itself — this module is the one that
     already owns the location table and the door query. The outward
     normal is the door minus the building's own centre, which by
     construction points away from the facade. */
  const _dq = new THREE.Vector3();
  const DOORS = [];
  for (const l of LOCATIONS) {
    const p = ctx.city?.doorPosition?.(l.id, _dq);
    if (!p || !Number.isFinite(p.x)) continue;
    const ox = p.x - l.world.x, oz = p.z - l.world.z;
    const ol = Math.hypot(ox, oz);
    if (ol < 0.4) continue;              // no usable facing; skip it
    DOORS.push({ id: l.id, x: p.x, z: p.z, ax: ox / ol, az: oz / ol });
  }

  const crowd = createCrowd(ctx, { groundY, roadLift, doors: DOORS });
  const crowdRng = ctx.makeRng('npc.crowd.spec');
  let crowdTarget = 0;

  /* A WANDERER'S SPOT IS THE ROAD NETWORK'S TO GIVE, NOT MINE. crowd.add
     drops them on a walkable node of its own choosing and consumes its
     own seeded stream doing it, so wanderers are queued in plan order
     and built in plan order — sorting them by distance would reorder
     that stream and move the entire crowd. They are cheap by then (the
     shared caches are warm) and they are walking, so where they enter
     the world reads as traffic rather than as pop-in. The two seed
     expressions below are the ones the immediate version produced —
     `crowd.agents.length` was `i` and `all.length` was the 24 clients
     plus `i` — written out so that deferring the build cannot change
     one hair on one head. */
  function planCrowd(n) {
    for (let i = 0; i < n; i++) {
      const spec = randomSpec(crowdRng, 'crowd' + (i + i));
      pending.push({
        kind: 'wander', spec, seed: 'crowd.' + (CLIENTS.length + i), detail: 'coarse',
        x: 0, y: 0, z: 0, yaw: 0, mode: 'idle', order: planIndex++,
      });
    }
    return n;
  }

  /**
   * RESIDENTS — the people who are simply *there*.
   *
   * A wandering crowd alone cannot populate a 900 m island: spread the
   * whole budget along the road network and a district gets one person
   * every twenty seconds, which reads as emptiness with occasional
   * traffic. What makes a square look inhabited is the people who are
   * not going anywhere — the stallholder, the two arguing outside the
   * bank, the one on the bench. They also cost a fraction of a wanderer
   * (no steering, no path following, and they are nearly always outside
   * the animation budget), so this is where the density belongs.
   */
  /* Locations that stand on open ground rather than on a forecourt. A
     door-hugging 8 m search leaves the plaza between the buildings
     empty, which is exactly what the review saw: one person in a 78 m
     frame of the market square. These get a search that reaches right
     across the square. */
  const PLAZA_KIT = new Set(['market', 'city', 'gold', 'stadium', 'learn', 'water']);

  function planResidents(perLoc) {
    const rng = ctx.makeRng('npc.residents.v2');
    let made = 0;
    for (const l of LOCATIONS) {
      if (l.id === 'apartment' || l.kit === 'interior' && rng() < 0.5) continue;
      const plaza = PLAZA_KIT.has(l.kit);
      const n = 1 + Math.floor(rng() * perLoc * (plaza ? 1.5 : 1));
      for (let i = 0; i < n; i++) {
        /* the order of these three draws is the order the immediate
           version made them in, and it has to stay that way: they come
           off one stream, so a swap re-rolls the whole street */
        const spec = randomSpec(rng, 'res.' + l.id + '.' + i);
        const p = plaza
          ? standingSpot(l, rng, { want: 1.4 + rng() * 3.4, near: 3.0, far: 22 + rng() * 6, tries: 34 })
          : standingSpot(l, rng, { want: 1.2 + rng() * 2.6, near: 3.0, far: 10.0, tries: 30 });
        const r = rng();
        const mode = r < 0.30 ? 'work' : r < 0.50 ? 'talk' : r < 0.60 ? 'sit' : 'idle';
        pending.push({
          kind: 'res', spec, seed: 'res.' + l.id + '.' + i, detail: 'coarse',
          x: p.x, y: p.y, z: p.z, yaw: p.yaw, mode, homeLoc: l.id, order: planIndex++,
        });
        made++;
      }
    }
    return made;
  }

  /* ------------------------------------------------------------
     The approach prompt
     ------------------------------------------------------------ */
  let promptFor = null;
  const promptPos = new THREE.Vector3();

  function updatePrompt(dt) {
    if (!ctx.ui || !ctx.wally) return;
    if (ctx.ui.modal || ctx.ui.dialogueOpen) {
      if (promptFor) { ctx.ui.prompt(null, null, { id: 'npc' }); promptFor = null; }
      return;
    }
    const wp = ctx.wally.position;
    let best = null, bd = TALK_RANGE * TALK_RANGE;
    for (const h of named.values()) {
      const d = h.root.position.distanceToSquared(wp);
      if (d < bd) { bd = d; best = h; }
    }
    if (best !== promptFor) {
      if (!best) ctx.ui.prompt(null, null, { id: 'npc' });
      promptFor = best;
    }
    if (best) {
      promptPos.copy(best.root.position);
      promptPos.y += best.height * 1.06;
      ctx.ui.prompt(best.client ? best.client.n : best.name, promptPos, {
        id: 'npc', key: 'E',
        sub: best.client ? best.client.role : '',
        action: () => api.talk(best.id),
      });
    }
  }

  /* Keyboard: E talks to whoever is in range.
     ui.js binds KeyE to its own door prompt, and a named client is by
     design standing near a door — so both would fire and the player
     would get a shop panel with a conversation on top of it. This
     module's listener is registered at stage 11 and the UI's at stage
     13, so on `window` this one runs first; consuming the event with
     stopImmediatePropagation when a person is actually in range gives
     the person priority and hands the key straight back otherwise.
     There is no polling and no reaching into another module's state. */
  function onKey(e) {
    if (e.code !== 'KeyE' || e.repeat) return;
    if (ctx.ui?.modal || ctx.ui?.dialogueOpen) return;
    if (!promptFor) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    api.talk(promptFor.id);
  }
  if (typeof window !== 'undefined') addEventListener('keydown', onKey);

  /* ------------------------------------------------------------
     Frame
     ------------------------------------------------------------ */
  /* How many skeletons may be written per frame. Everything else keeps
     its pose — a frozen figure at 40 m is invisible as a defect, a
     stuttering one at 6 m is not, so the budget is spent nearest first
     by taking them in scene order after the frustum test. */
  const budget = Math.round(clamp(16 + (q.particles ?? 1) * 22, 12, 46));
  let elapsed = 0;
  let repopT = 0;

  /* ------------------------------------------------------------
     THE SKY CROWD, built. See the block above AIR_NEAR for why.

     ONE DRAW CALL, whatever the population. An InstancedBufferGeometry
     of one quad, four instance streams (foot position, shirt, skin,
     state), and a shader that builds the billboard and the silhouette
     itself — no texture, because §"no external assets" and because a
     procedural silhouette can change shape when he looks up and a
     sprite sheet cannot.

     THE BILLBOARD IS CYLINDRICAL, not spherical: the quad's up is
     WORLD up and only its right is the camera's. A view-aligned quad
     rolls with the boom and a street of them shears together, which
     reads as a bug at any size. Standing them upright costs one row of
     the view matrix.
     ------------------------------------------------------------ */
  let sky = null;                 // built on the first lift-off, never at boot
  let skyMode = 'on';             // the runtime revert — dbg.skyCrowd()
  let skyDrawn = 0, skyCand = 0, skyNotice = 0;

  function buildSky() {
    const cap = all.length + 96;
    const g = new THREE.InstancedBufferGeometry();
    /* x in [-0.5, 0.5], y in [0, 1] — feet at y = 0, so the instance
       position is the ground point and needs no half-height offset. */
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const iPos = mk(3), iCol = mk(3), iSkin = mk(3), iState = mk(3);
    g.setAttribute('iPos', iPos);
    g.setAttribute('iCol', iCol);
    g.setAttribute('iSkin', iSkin);
    g.setAttribute('iState', iState);
    g.instanceCount = 0;

    const uni = {
      /* x: pixels per metre at one metre of depth — (h/2)/tan(fov/2),
         refreshed on resize and whenever the lens changes fov (the
         flight camera does, per altitude). y: AIR_MIN_PX. */
      uPx: { value: new THREE.Vector2(900 * 0.5 / Math.tan(30 * Math.PI / 360), AIR_MIN_PX) },
      uFog: { value: new THREE.Vector2(100, 520) },
      uFogCol: { value: new THREE.Color(0xb8def0) },
      uFogCap: { value: AIR_FOG_CAP },
      uFade: { value: 0 },        // the whole field ramps in with the flight
    };

    const mat = new THREE.ShaderMaterial({
      name: 'npc.skycrowd',
      uniforms: uni,
      transparent: true,
      depthWrite: false,          // alpha-blended specks; they must not punch the depth buffer
      depthTest: true,            // …but a person behind Market Hall is behind Market Hall
      side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute vec3 iPos;
        attribute vec3 iCol;
        attribute vec3 iSkin;
        attribute vec3 iState;      // x: notice 0..1  y: body height m  z: unused
        uniform vec2 uPx;
        uniform vec2 uFog;
        varying vec2  vUv;
        varying vec3  vCol;
        varying vec3  vSkin;
        varying float vNotice;
        varying float vFog;
        varying float vSoft;
        varying float vTiny;
        void main() {
          /* row 0 of the view matrix IS the camera's right in world
             space (the rotation block of a rigid inverse is its
             transpose), and mat4 indexing is column-major. */
          vec3 right = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
          float depth = max( -( viewMatrix * vec4( iPos, 1.0 ) ).z, 0.001 );
          float h  = iState.y;
          float px = ( h * uPx.x ) / depth;
          /* hold the floor: grow the figure in world units until it is
             uPx.y pixels tall, never shrink it */
          h *= max( 1.0, uPx.y / max( px, 0.0001 ) );
          /* how far past "has a shape" he is — 0 while the silhouette
             can be resolved, 1 once he is a handful of pixels.

             WRITTEN AS 1 - smoothstep, NOT AS A REVERSED EDGE PAIR.
             smoothstep(edge0, edge1, x) is UNDEFINED in GLSL when
             edge0 >= edge1 — not clamped, not mirrored, undefined —
             and it does not fail loudly, it returns whatever that
             driver's polynomial happens to give. Written the wrong way
             round, this term came back zero here: the solid mark in the
             fragment stage never engaged at any distance, and a crowd
             whose size I had verified as 6.7 px against the uniforms
             rendered as one-pixel flecks I could not find in the frame
             holding their own screen coordinates. Both descending
             smoothsteps in this shader are written this way now. */
          float tiny = 1.0 - smoothstep( 4.5, 9.0, max( px, uPx.y ) );
          /* AND HE BROADENS AS HE SHRINKS. 0.42 of his height is the
             true width of a person and it is 2.5 px at 240 m — a
             needle, which is not what a person looks like from the
             air. A shoulder-width mark is both more honest at this
             range (arms, bag, coat) and the difference between a
             crowd and a scatter of noise. */
          float w = h * mix( 0.42, 0.66, tiny );
          vec3 wp = iPos + right * ( position.x * w ) + vec3( 0.0, position.y * h, 0.0 );
          gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
          vUv     = vec2( position.x + 0.5, position.y );
          vCol    = iCol;
          vSkin   = iSkin;
          vNotice = iState.x;
          vTiny   = tiny;
          /* the silhouette's edge, in UV, sized to ~1.3 screen pixels —
             derivatives would do this too, but this is one multiply and
             it is correct on every driver.

             THE CEILING OF 0.12 IS LOAD-BEARING. It was 0.34, which is
             a THIRD of the quad of feather on every edge: the three
             smoothsteps that build the body then multiply to a peak
             alpha near 0.3 and a six-pixel pedestrian renders as a
             one-pixel smear you cannot find in the frame with its own
             coordinates in your hand. Feathering is for antialiasing a
             shape; when there is no shape left to antialias the answer
             is the solid mark below, not more feather. */
          vSoft   = clamp( 1.3 / max( px, uPx.y ), 0.015, 0.12 );
          vFog    = clamp( ( depth - uFog.x ) / max( uFog.y - uFog.x, 1.0 ), 0.0, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        uniform vec3  uFogCol;
        uniform float uFogCap;
        uniform float uFade;
        varying vec2  vUv;
        varying vec3  vCol;
        varying vec3  vSkin;
        varying float vNotice;
        varying float vFog;
        varying float vSoft;
        varying float vTiny;
        void main() {
          float y = vUv.y, x = abs( vUv.x - 0.5 );
          /* THE FIGURE, as a half-width profile: legs narrow, torso
             wide at the shoulder, and the head a disc on top. Three
             smoothsteps; at a dozen pixels it is a person-shaped
             smudge, which is exactly what a person that size is. */
          float hw   = mix( 0.115, 0.215, smoothstep( 0.34, 0.54, y ) )
                     * ( 1.0 - smoothstep( 0.70, 0.79, y ) );
          float body = ( 1.0 - smoothstep( hw - vSoft, hw + vSoft, x ) )
                     * smoothstep( -vSoft, vSoft, y )
                     * ( 1.0 - smoothstep( 0.74 - vSoft, 0.80, y ) );
          /* THE HEAD IS THE ONLY THING THAT CHANGES WHEN HE NOTICES,
             and it is the right thing: a face tipped back at a balloon
             turns its lit side toward a camera that is ABOVE it, so the
             speck grows a pale cap. It is the one cue that reads at
             three pixels — a head tilt does not, an arm does not. */
          float hr   = 0.100 + 0.024 * vNotice;
          float hd   = length( vec2( ( vUv.x - 0.5 ) * 1.06, y - 0.876 ) );
          float head = 1.0 - smoothstep( hr - vSoft, hr + vSoft, hd );
          /* AND WHEN THERE IS NO SHAPE LEFT, A SOLID MARK.

             THE MEASUREMENT THIS EXISTS FOR. At six pixels the profile
             above covers about a third of its own box at partial alpha,
             and cropped at the exact screen coordinates the ladder
             printed, a pedestrian on the Market Hall road was a
             one-pixel teal fleck — rendered, counted, and impossible to
             find in the frame. Below about nine pixels a waist and a
             pair of legs are not information anybody receives, so spend
             the box on COVERAGE instead: one opaque lozenge, his own
             shirt colour, inked. The crossfade is over 9 to 4.5 px, so
             nothing swaps representation while it is big enough to see
             it swap. */
          float e    = length( vec2( ( vUv.x - 0.5 ) / 0.42, ( y - 0.52 ) / 0.50 ) );
          float blob = 1.0 - smoothstep( 1.0 - vSoft * 2.4, 1.0, e );
          float a    = mix( max( body, head ), max( blob, head * 0.9 ), vTiny );
          if ( a < 0.004 ) discard;
          /* trousers are the shirt's own dark; one mix, no second
             attribute stream for a colour nobody can resolve */
          vec3 col = mix( vCol * 0.58, vCol, smoothstep( 0.38, 0.52, y ) );
          vec3 face = mix( vSkin, vSkin * 1.28 + 0.20, vNotice );
          col = mix( col, face, clamp( head, 0.0, 1.0 ) );
          col *= 1.0 + 0.10 * vNotice;
          /* THE INK, which is the same answer toon.js gives everywhere
             else in this game and the reason a Wind-Waker frame stays
             legible when it is busy. Coverage falls off across the soft
             boundary, so this darkens exactly the rim — and on a figure
             only a few pixels tall the whole figure IS rim, which is
             precisely the size at which he needs to be a dark mark on a
             bright ground rather than a tint of it. It is applied
             BEFORE the haze so the outline recedes with the person
             instead of sitting on top of the aerial perspective. */
          float ink = 1.0 - smoothstep( 0.22, 0.88, a );
          col = mix( col, col * 0.30, ink * 0.80 );
          col = mix( col, uFogCol, min( vFog, uFogCap ) );
          gl_FragColor = vec4( col, a * uFade );
          #include <colorspace_fragment>
        }`,
    });

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'npc.skycrowd';
    mesh.frustumCulled = false;   // culled per instance on the CPU, below
    mesh.renderOrder = 3;
    mesh.visible = false;
    root.add(mesh);
    return { mesh, geo: g, mat, uni, iPos, iCol, iSkin, iState, cap };
  }

  /** Refill the instance streams from whoever the LOD loop tagged.
      Called once a frame while flying, never otherwise. */
  function skyUpdate(dt) {
    if (!sky) return;
    sky.uni.uFade.value = damp(sky.uni.uFade.value, skyDrawn > 0 ? 1 : 0, 4.5, dt);
    sky.mesh.visible = sky.uni.uFade.value > 0.01 && skyDrawn > 0;
    sky.geo.instanceCount = skyDrawn;
    if (!skyDrawn) return;
    const cam = ctx.camera;
    /* pixels per metre at one metre of depth, off the LENS — the
       flight camera changes its fov with altitude, so a constant here
       would put the AIR_MIN_PX floor in the wrong place at cruise */
    const ph = ctx.renderer?.domElement?.height || 900;
    sky.uni.uPx.value.set(ph * 0.5 / Math.tan(cam.fov * Math.PI / 360), AIR_MIN_PX);
    const fog = ctx.scene.fog;
    if (fog && Number.isFinite(fog.near)) {
      sky.uni.uFog.value.set(fog.near, fog.far);
      sky.uni.uFogCol.value.copy(fog.color);
    }
    sky.iPos.needsUpdate = true;
    sky.iCol.needsUpdate = true;
    sky.iSkin.needsUpdate = true;
    sky.iState.needsUpdate = true;
  }

  /* ------------------------------------------------------------
     THE STREAMER — the rest of the island arriving.

     Everything boot did not mesh is turned into a person here, a few
     milliseconds at a time, nearest to the camera first. The budget is
     deliberately fat for the first couple of seconds: the whole point is
     that the streets are full by the time the player has finished
     looking around, and by then the shared caches are warm and a person
     costs well under a millisecond, so the queue drains in about thirty
     frames. It thins to a trickle afterwards, which is what keeps the
     late arrivals — and any district the player walks into before the
     queue is empty — from costing a visible frame.

     `sortT` is a timer only because re-sorting four hundred records
     every frame would cost more than building one of them. The ORDER
     records are built in is a function of position, never of time, so
     the same build populates the same world the same way twice.
     ------------------------------------------------------------ */
  const STREAM_EARLY = 2.5;         // seconds of the fat budget
  let sortT = 0;

  function stream(dt, camPos) {
    if (!pending.length) return;
    sortT -= dt;
    if (sortT <= 0) {
      sortT = 0.35;
      /* Wanderers keep their plan order (crowd.add owns their spot and
         their stream); everyone else is ranked by how close they are.
         Clients carry a bonus because a person you can talk to is worth
         more than scenery at the same distance. */
      for (const r of pending) {
        r.key = r.kind === 'wander' ? 1e6 + r.order
          : Math.hypot(r.x - camPos.x, r.z - camPos.z) - (r.kind === 'client' ? 120 : 0);
      }
      pending.sort((a, b) => a.key - b.key);
    }
    /* A SCREENSHOT IS NOT A PLAYER. tools/shot.mjs fires as soon as
       __WALLY_READY__ is set and it has to photograph a settled world,
       so under ?shot the queue drains on the first frame instead of
       over the first second — same population, same order, no timing in
       it at all, and every existing reference shot still matches. */
    const ms = ctx.flags?.shot ? Infinity : (elapsed < STREAM_EARLY ? 14 : 4);
    const t0 = performance.now();
    let n = 0;
    /* alternate the two queues so the crowd walks in while the
       forecourts fill, instead of after them */
    while (pending.length && performance.now() - t0 < ms) {
      let i = 0;
      if ((n & 1) && pending[0].kind !== 'wander') {
        const w = pending.findIndex((r) => r.kind === 'wander');
        if (w >= 0) i = w;
      }
      buildRec(pending.splice(i, 1)[0]);
      n++;
    }
  }

  function update(dt, t) {
    elapsed = t;
    const cam = ctx.camera;
    /* The view matrix is only refreshed by the renderer, i.e. AFTER
       every update() has run, so reading it here culls against last
       frame's camera — which on a fast pan is a whole population
       popping in a frame late. Recompute it. */
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    _mvp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_mvp);
    cam.getWorldPosition(_v);

    stream(dt, _v);

    /* --- population tracks the clock: how many of the wanderers are
       out at all. Recomputed on a slow timer, never per frame. --- */
    repopT -= dt;
    if (repopT <= 0) {
      repopT = 3.5;
      const hour = ctx.game?.time?.hour ?? 12;
      crowdTarget = Math.round(baseCrowd * crowd.density(hour));
      for (let i = 0; i < crowd.agents.length; i++) {
        crowd.agents[i].human.asleep = i >= crowdTarget;
      }
    }

    /* ------------------------------------------------------------
       HOW FAR A SKELETON IS WORTH RUNNING IS A QUESTION ABOUT PIXELS,
       AND ANIM_FAR ANSWERS IT IN METRES.

       62 m is the right answer for the gameplay camera, which sits
       two metres off the ground: a pedestrian at 62 m is about 25 px
       tall at 1600x900 and freezing him there costs nothing anybody
       can see. From the balloon it is not a threshold at all, it is a
       refusal. Measured over Main Street at 13:00 with the REAL
       flight camera (tools/gawkladder.mjs), the nearest person to the
       LENS is 17.5 m at 12 m of altitude, 25.9 m at 19 m, 47.5 m at
       34 m and 62.1 m at 45 m — and the people in the FRAME are
       further still, because the boom sits 20-30 m back and pitches
       down only 18-26 degrees, so the ground under the basket is
       below the bottom edge of the picture and what is on screen is
       60-160 m out. The count of animated people went to ZERO at 19 m
       and stayed there at every altitude above it. That is the whole
       of "nobody notices the balloon above nineteen metres": there
       was nobody left running a skeleton to notice with.

       So the reach follows the lens up. Everything else about the
       gate is untouched — frustum first, same head-count budget — and
       on the ground `flying` is false and every number below is the
       one the crowd has always used, to the digit. It is also not a
       cost: measured, the flight spends FEWER skeletons than walking
       does, because there is less on screen.
       ------------------------------------------------------------ */
    const flyingNow = !!(ctx.wally && ctx.wally.flying) && gawkReach === 'lens';
    const camUp = flyingNow ? Math.max(0, _v.y - groundY(_v.x, _v.z)) : 0;
    const animFar = flyingNow
      ? clamp(ANIM_FAR + camUp * 3.4, ANIM_FAR, ANIM_FLY_MAX) : ANIM_FAR;

    /* ------------------------------------------------------------
       AND THE DRAW CULL, WHICH IS THE ONE THAT MATTERED.

       `airOn` is the ONLY gate on everything below. On foot it is
       false, `drawMax` is FAR to the digit, the sky crowd is never
       built, and the loop under this takes the branches it has always
       taken. That is the guard rail: the on-foot game's culling is not
       touched by any of this.

       THE NOTICE RADIUS IS NOW THE DRAW RADIUS. IF YOU CAN SEE HIM, HE
       CAN SEE YOU — one law, one constant, and no third number to get
       wrong. It used to be max(70, animFar), capped at 190, under FAR,
       which is why it could never reach anybody in the picture.

       THE FIRST VERSION OF THIS FIX TIED IT TO ALTITUDE INSTEAD —
       camUp * AIRVIEW.gain, the sight radius events.js already uses —
       and it was elegant and it was wrong, because the boom pitches
       down only 16 to 30 degrees at every altitude, so the ground
       under the basket is BELOW the bottom of the frame and what is in
       the picture is always further out than the altitude implies.
       Measured on the pinned ladder: at 20 m of altitude the nearest
       person in frame is past 150 m while camUp * gain is 52, floored
       to 70 — reach 70, notice 0, a rung that drew 35 people and had
       none of them look up. The altitude is not what decides who can
       see a twenty-metre envelope; the horizon is.

       IT IS STILL AIRVIEW'S NUMBER, one step removed: AIR_FAR is
       AIRVIEW.max plus the boom's standoff, so "how far the crowd can
       be and still notice" and "how far you can see from up here" are
       the same statement measured from the two ends. And it costs a
       distance test and a damp per person — the expensive thing was
       always the skeleton, which is a different gate (below).

       IT IS NOT THE ANIMATION REACH. Those are now separate numbers and
       that separation IS the fix: noticing costs a distance test and a
       damp, per person, and it is what puts the pale faces and the
       stopped feet in the picture. A skeleton costs a skeleton, so
       `animFar` stays where round two left it and is additionally
       capped at the skinned band — solving bones for a mesh that is
       being drawn as a billboard is the same waste as before, wearing
       a different hat.
       ------------------------------------------------------------ */
    const airOn = flyingNow && skyMode === 'on';
    const drawMax = airOn ? AIR_FAR : FAR;
    /* ONE REPRESENTATION PER PERSON, AND ONE LINE BETWEEN THEM. Inside
       `skinFar` everybody is a full skinned body — airborne the
       thinning band is pushed out to the same line, so nothing is
       dropped from the near half at all — and outside it everybody is
       an instance. Mixing the two in one distance band is the only way
       this reads as a seam, so there is no band where both occur.
       Airborne this is a NET SAVING even before the billboards are
       counted: it retires every skinned draw between 150 and 200 m and
       buys back the quarter of 110-150 m that thinning used to throw
       away, which is the half of the band the player can still see. */
    const skinFar = airOn ? AIR_NEAR : FAR;
    const thin0 = airOn ? AIR_NEAR : THIN0;
    noticeR = airOn ? AIR_FAR : Math.max(GAWK_R, animFar);
    if (airOn && !sky) sky = buildSky();
    skyDrawn = 0; skyCand = 0; skyNotice = 0;

    /* --- level of detail ---
       Sorted by nothing: the frustum test throws away most of them and
       the budget takes the rest in scene order, which is stable frame
       to frame and therefore never flickers. */
    let live = 0;
    for (const h of all) {
      h.airOn = false;
      if (h.asleep) { h.root.visible = false; h.active = false; continue; }
      const d = h.root.position.distanceTo(_v);
      h.dist = d;
      /* EXEMPT: a character the game is currently telling a story with.
         The Mayor mid-dash is 300 m away down the far side of the island
         for most of a race, which is past FAR and well past the thinning
         band — and a rival who vanishes because he is winning is not a
         rival. He keeps his skeleton too: he is the only figure on the
         island whose gait is the point. */
      if (h.exempt) { h.root.visible = true; h.active = true; live++; continue; }
      if (d > drawMax) { h.root.visible = false; h.active = false; continue; }
      /* --- THE INSTANCED BAND. Unreachable on foot: skinFar is FAR
         and drawMax is FAR, so `d > skinFar` implies the line above
         already took him. --- */
      if (d > skinFar) {
        h.root.visible = false; h.active = false;
        skyCand++;
        _sphere.center.copy(h.root.position);
        _sphere.center.y += h.height * 0.55;
        /* a generous radius: the shader may GROW the billboard to hold
           AIR_MIN_PX, so a figure whose true sphere misses the edge of
           the frame can still have pixels inside it */
        _sphere.radius = h.height * 1.15;
        if (!_frustum.intersectsSphere(_sphere)) continue;
        if (skyDrawn >= sky.cap) continue;
        const i3 = skyDrawn * 3;
        const p = h.root.position, pal = h.pal;
        sky.iPos.array[i3] = p.x; sky.iPos.array[i3 + 1] = p.y; sky.iPos.array[i3 + 2] = p.z;
        sky.iCol.array[i3] = pal.shirt.r; sky.iCol.array[i3 + 1] = pal.shirt.g;
        sky.iCol.array[i3 + 2] = pal.shirt.b;
        sky.iSkin.array[i3] = pal.skin.r; sky.iSkin.array[i3 + 1] = pal.skin.g;
        sky.iSkin.array[i3 + 2] = pal.skin.b;
        /* the notice weight is LAST FRAME'S — gawkUpdate runs after
           this loop, by one frame at 60 Hz, which is 16 ms of lag on a
           gesture that ramps over two seconds */
        const nw = h.gawkOn ? h.lookW : 0;
        sky.iState.array[i3] = nw;
        sky.iState.array[i3 + 1] = h.height;
        sky.iState.array[i3 + 2] = 0;
        if (nw > 0.3) skyNotice++;
        h.airOn = true;
        skyDrawn++;
        continue;
      }
      /* THINNING, not culling. Quadrupling the population to make a
         square look inhabited also quadruples what a vista has to draw,
         and a figure past 110 m is a dozen pixels of colour that §2.4
         has already hazed toward #B8DEF0. So beyond THIN0 a stable,
         per-person fraction drops out — deterministic, so it never
         flickers, and graded, so the district in front of you keeps
         every one of its people. (Airborne `thin0` is `skinFar`, so
         this never fires: see the note on skinFar.) */
      if (d > thin0 && h.lodKey > 1 - smoothstep(THIN0, FAR, d) * THIN_MAX) {
        h.root.visible = false; h.active = false; continue;
      }
      _sphere.center.copy(h.root.position);
      _sphere.center.y += h.height * 0.55;
      _sphere.radius = h.height * 0.66;
      const vis = _frustum.intersectsSphere(_sphere);
      h.root.visible = vis;
      const cast = vis && d < SHADOW_FAR;
      if (cast !== h._cast) { h._cast = cast; h.body.castShadow = cast; h.head.castShadow = cast; }
      h.active = vis && d < animFar && live < budget;
      if (h.active) live++;
    }

    /* --- the balloon, if it is up. BEFORE both loops below: it decides
       who is looking at the sky, and each loop then runs that person's
       animator once with the answer already written. --- */
    const wp = ctx.wally ? ctx.wally.position : null;
    gawkUpdate(dt, wp);
    /* the sky crowd's upload, after the pass that decides who is
       looking up — the instance streams were filled in the LOD loop
       above, this is the one place that hands them to the driver */
    if (sky) skyUpdate(dt);

    /* --- standers: named clients, residents outside their shops, and
       anyone the debug lineup froze. They notice Wally, turn toward
       him and hold his eye. --- */
    for (const h of all) {
      if (h.agent && !h.agent.frozen) continue;      // the crowd owns them
      if (!h.active) continue;
      if (h.mayorDriven) continue;                   // the dash owns him
      if (wp && !h.gawkOn) {
        const d = h.root.position.distanceTo(wp);
        h.lookW = damp(h.lookW, d < 8 ? 1 : 0, 3.2, dt);
        h.lookVec.set(wp.x, wp.y + 1.18, wp.z);
        h.anim.lookTarget = h.lookVec;
        h.anim.lookW = h.lookW;
        /* turn the body toward him when he is close, drift back after */
        const wantYaw = d < 4.4
          ? Math.atan2(wp.x - h.root.position.x, wp.z - h.root.position.z)
          : h.baseYaw;
        const cur = h.root.rotation.y;
        const dy = Math.atan2(Math.sin(wantYaw - cur), Math.cos(wantYaw - cur));
        h.root.rotation.y = cur + dy * (1 - Math.exp(-3.2 * dt));
      }
      h.anim.update(dt, t, h.forceLoco || _still);
    }

    /* --- crowd --- */
    crowd.update(dt, t, wp, budget);

    /* --- speech and gestures time out --- */
    for (const h of all) {
      if (h.sayT > 0) { h.sayT -= dt; if (h.sayT <= 0) h.anim.setMode(h.baseMode || 'idle'); }
    }

    /* One object read per frame until ctx.game exists, then never
       again — see registerPortrait. It cannot be done at init(): npc.js
       boots before game.js in main.js's order. */
    if (!portraitDone) registerPortrait();
    if (!mayorPortraitDone) registerMayorPortrait();

    happyUpdate(dt, t);
    mayorUpdate(dt, t);
    bubbleUpdate(dt, t, _v);
    updatePrompt(dt);
  }

  /* ============================================================
     HAPPY — the first person in Bull Bear City to say your name.

     THE SPLIT. The data agent owns WHETHER this happens: it emits
     bus 'story' { beat: 'happy' } the instant the phone is read, keeps
     ctx.game.story.happyPending() true until it is over, and expects
     ctx.game.actions.metHappy() when it is. The UI agent owns HOW THE
     LINE IS PRESENTED: it goes out through ctx.ui.dialogue and nothing
     here draws a pixel of text. What is left — and what this block is —
     is the STAGING: who he is, where he comes from, how he crosses the
     ground, where he stops, and how he stops being there.

     WHY HE IS NOT A CROWD AGENT. crowd.js drives its wanderers along
     the road network with a seeded random walk and its own pauses; it
     is exactly the wrong tool for a character who has to arrive at one
     specific spot, at one moment, facing one person. He is meshed by
     the same humans.js as everyone else — same clay, same skeleton,
     same animator — and steered by the code below instead.

     THE FOUR BEATS

       approach  He starts 11 m off, BEHIND Wally's shoulder where the
                 follow camera is not looking, and walks in. A real
                 crossing at 1.55 m/s with the walk cycle the rest of
                 the city uses — not a pop-in and not a slide.
       face      He stops 1.95 m out, which is conversational distance
                 for two people who have not met, and turns over
                 ~0.45 s. Wally turns back: ctx.wally.look() aims the
                 head, and the trunk and ears follow through the spring
                 chains for free.
       speak     One dialogue card, the line exactly as written, his
                 animator in 'talk'. The card is a promise; the beat
                 waits on it, with a ceiling so a player who leaves an
                 unclosed card cannot strand the story flag.
       leave     He turns away, walks out past where he came in, and
                 dissolves over 1.5 s once he is 6.6 m out and moving.
                 The distance is the point: measured at 4.2 m he was
                 still close enough to read as a model turning to glass
                 beside you. From 6.6 m, walking away at 1.9 m/s, he is
                 a receding figure that stops being there — which is
                 the difference between mysterious and buggy. Then he
                 is disposed and metHappy() is called.

     "MYSTERIOUSLY" IS A TIMING DECISION, NOT AN EFFECT. The fade only
     begins once his back is turned and he is already leaving, and it
     runs slower than he walks, so what the eye reports afterwards is
     "he walked off and I lost him", not "the model turned to glass".
     See humans.fadeMaterial() for why it cannot be the material's own
     opacity.
     ============================================================ */
  const HAPPY_LINE = "Hey Wally, I'm Happy. You're the new trader in town right? "
    + 'This place could really use your help. Happy tokenizing!';

  /* HAPPY IS A LIKENESS. There is a photograph of the real person on
     disk at ref/happy-ref.webp and every field below is read off it,
     then translated into the clay/vinyl vocabulary §1.2 states for
     everybody in this game — a stylised likeness, not a portrait. What
     carries identity out of that photograph, in the order the eye finds
     it:

       the hair       short, light, parted at the side and swept over.
                      Not a quiff: a quiff is symmetric and stands up,
                      and this cut is thick on one side of a line and
                      combed forward over the temple on the other. It is
                      the first thing you recognise about him from any
                      angle, so it is real geometry — see `sidepart` in
                      humans.js — and not a colour on a cap.
       the clothes    charcoal unstructured blazer worn OPEN over a
                      white crew-neck tee, cream/stone trousers. Nobody
                      else on this island wears a jacket; four hundred
                      pedestrians are one shirt above a hem and one
                      trouser below it. The open blazer, with the bright
                      V of the tee down the middle of a dark field, is a
                      silhouette no wanderer can accidentally produce —
                      which is what the old orange shirt was for, done
                      properly.
       the print      a dark elephant on the tee with lettering over and
                      under it. It is Wally's own mark, so it is reused
                      rather than invented (humans.js teePrintGeo, from
                      ref/wally-logo.png).
       the face       longish, straight nose, defined jaw, clean-shaven,
                      fair. `oval` (rx 0.1385, ry 0.207, jaw 0.86) is
                      the long-and-defined one; `long` is 12 % narrower
                      again and rendered as a slab, and it also warps
                      the cached hair hardest, which is what turned the
                      parting into a hood. `age: 0`, not 1: he is early
                      thirties and 1 adds a nasolabial fold the
                      photograph does not have.

     THE HUE STAYS BRAND.token even though nothing he wears is orange
     any more: ui/style.js draws his dialogue and phone portrait on a
     disc of `hue`, so it is his card colour, not his shirt. */
  const HAPPY_SPEC = {
    id: 'happy',
    n: 'Happy',
    role: 'Tokenizer',
    skin: 'porcelain',
    face: 'oval',
    hair: 'sidepart',
    /* `blonde` (#C69A55), not `platinum` (#DCC9A4). Measured on the
       first render: platinum sits 6 % from `porcelain` skin (#F0D2BC)
       in luminance and 4 points in hue, so the hair and the forehead
       fused into one pale mass and he read as a bald man with a cone on
       his head. A golden blonde is unambiguously HAIR against a fair
       face, which is the whole point of the description. */
    hairCol: 'blonde',
    beard: 'none',
    specs: 'none',
    hat: 'none',
    hue: '#F5913C',            // BRAND.token — his CARD colour, see above
    /* the outfit, from the photograph */
    jacket: 0x3a3d42,          // charcoal, unstructured, worn open
    shirtCol: 0xf2f0ea,        // white tee. §7: not 0xffffff — a lit
                               // cheek tops out at #DEDEDD and a pure
                               // white tee would be the brightest thing
                               // in any frame he is in
    trouserCol: 0xd9cdb4,      // cream / stone
    shoeCol: 0x5a4b42,
    jacketOpen: [0.044, 0.086],
    tee: true,                 // the elephant print
    teeWidth: 0.106,
    teeY: 1.138,
    age: 0,
    mood: 'warm',
    build: 0.94,
    stature: 1.02,
  };

  const HAPPY = {
    APPROACH_SPEED: 1.55,
    LEAVE_SPEED: 1.90,
    START_DIST: 11.0,
    STOP_DIST: 1.95,
    LEAVE_DIST: 17.0,
    FADE_START: 6.6,           // metres of retreat before he starts to go
    FADE_TIME: 1.5,
    SPEAK_MAX: 22.0,           // ceiling on waiting for the dialogue card
  };

  let happy = null;            // the human, while he exists
  let happyState = 'none';     // none|approach|face|speak|leave|done
  let happyT = 0;
  let happyFade = 1;
  const _hTarget = new THREE.Vector3();
  const _hExit = new THREE.Vector3();
  const _hv = new THREE.Vector3();

  /** Somewhere off-camera to come from: behind Wally, and preferably
      near a road so he is not walking out of a hedge. */
  function happyStart(wp, wyaw) {
    const rng = ctx.makeRng('npc.happy.entry');
    let best = null, bestScore = -1e9;
    for (let i = 0; i < 20; i++) {
      const a = wyaw + Math.PI + (rng() - 0.5) * 2.6;   // the arc behind him
      const r = HAPPY.START_DIST * (0.86 + rng() * 0.30);
      const x = wp.x + Math.sin(a) * r, z = wp.z + Math.cos(a) * r;
      const y = ctx.world.heightAt(x, z);
      if (!Number.isFinite(y)) continue;
      const slope = Math.abs(y - wp.y);
      const road = ctx.world.distanceToRoad ? ctx.world.distanceToRoad(x, z) : 1.6;
      const s = -slope * 3.0 - Math.abs(road - 1.6) * 0.5;
      if (s > bestScore) { bestScore = s; best = { x, y: y + roadLift(x, z), z }; }
    }
    return best || { x: wp.x, y: wp.y, z: wp.z - HAPPY.START_DIST };
  }

  function happyStopPoint(wp, wyaw) {
    /* a shade off his centre line, so the two are not nose to nose */
    const off = 0.34;
    _hTarget.set(
      wp.x + Math.sin(wyaw) * HAPPY.STOP_DIST + Math.cos(wyaw) * off, 0,
      wp.z + Math.cos(wyaw) * HAPPY.STOP_DIST - Math.sin(wyaw) * off);
    _hTarget.y = groundY(_hTarget.x, _hTarget.z);
    return _hTarget;
  }

  /* ------------------------------------------------------------------
     HIS FACE, WHEREVER A FACE IS DRAWN IN 2D.

     ui/style.js `portrait(client)` draws a real vector portrait from
     exactly the fields HAPPY_SPEC already carries — skin, face, hair,
     hairCol, beard, specs, hat, mood, age, hue — and every place a
     speaker gets an avatar (ui/dialogue.js makeAvatar, ui/phone.js
     avatarFor, the client cards in ui/menus.js) resolves it through
     `ctx.game.data.clientById`. Happy is not a CLIENT — you never trade
     with him, he is a story beat — so he was not in that map, and every
     one of those call sites fell through to glyphAvatar: an orange disc
     with the letter H, which is what shipped.

     Registering the record is therefore the whole fix, and it is a
     registration and not a second portrait system. He goes into
     `clientById` only, never into `data.clients`, so the client roster,
     the order book and every list that iterates the ARRAY are untouched
     — only the by-id lookups the avatars use can see him.

     THE TABLE IS DEEP-FROZEN (data.js deepFreeze), so the entry cannot
     simply be written into it. `ctx.game` itself is not frozen, so what
     goes in is a SHALLOW COPY of the data record whose `clientById` is
     a shallow copy plus one key. Everything else in it — `clients`,
     `assets`, `rides`, every array and every table — comes across BY
     REFERENCE and is the identical object it was, so nothing that reads
     game.data reads anything different, and game.js's own logic does
     not go through ctx.game.data at all (it imports DATA directly).
     Verified before it is kept: if the copy does not take, the letter
     H comes back and nothing else changes.

     THIS BELONGS IN data.js, as one record next to CLIENTS, and the
     whole function should be deleted when the data agent adds it: this
     file owns how he is MESHED, not what the UI knows about him. It is
     here because the character layer is the only place that currently
     holds his appearance, and an avatar that silently degrades to an
     initial is worse than a cross-layer write that says so out loud.
     ------------------------------------------------------------------ */
  let portraitDone = false;
  function happyPortraitRecord() {
    return {
      id: HAPPY_SPEC.id, n: HAPPY_SPEC.n, role: HAPPY_SPEC.role,
      skin: HAPPY_SPEC.skin, face: HAPPY_SPEC.face,
      /* style.js draws from its OWN vocabulary of seventeen hair paths
         and has no `sidepart`; `side` is the one that means the same
         thing there — a short cut with a parting swept over. */
      hair: 'side',
      hairCol: HAPPY_SPEC.hairCol, beard: HAPPY_SPEC.beard,
      specs: HAPPY_SPEC.specs, hat: HAPPY_SPEC.hat,
      age: HAPPY_SPEC.age, mood: HAPPY_SPEC.mood, hue: HAPPY_SPEC.hue,
      /* NOT a tradeable client, and marked so, in case anything ever
         does walk this map expecting an order book on every row. */
      npc: true,
    };
  }
  function registerPortrait() {
    if (portraitDone) return false;
    const game = ctx.game;
    const data = game?.data;
    const reg = data?.clientById;
    if (!reg) return false;               // game not up yet; try again later
    portraitDone = true;
    if (reg[HAPPY_SPEC.id]) return true;  // data.js has adopted him — good
    const rec = happyPortraitRecord();
    try {
      reg[HAPPY_SPEC.id] = rec;
      if (reg[HAPPY_SPEC.id]) return true;   // it was writable after all
      game.data = { ...data, clientById: { ...reg, [HAPPY_SPEC.id]: rec } };
      return !!ctx.game?.data?.clientById?.[HAPPY_SPEC.id];
    } catch (e) {
      try {
        game.data = { ...data, clientById: { ...reg, [HAPPY_SPEC.id]: rec } };
        return !!ctx.game?.data?.clientById?.[HAPPY_SPEC.id];
      } catch (e2) { return false; }      // the letter H is survivable
    }
  }

  /**
   * Run the encounter. Safe to call twice: the second call is ignored
   * while one is in flight.
   * @param {{instant?:boolean}} o  instant places him at the stop point
   *        already facing Wally — for the screenshot harness.
   */
  function playHappy(o = {}) {
    if (happy) return happy;
    registerPortrait();          // before the card, not after it
    const w = ctx.wally;
    if (!w) return null;
    const wp = w.position;
    const wyaw = w.rotation.y;

    happy = makeHuman(HAPPY_SPEC, 'npc.happy', 'fine');
    happy.name = 'Happy';
    happy.baseMode = 'idle';
    /* HE TALKS WITH HIS HAND OPEN, as the man in the photograph does —
       see Agent.talk in crowd.js. It is also the only version of the
       gesture that does not park a forearm over the front of the shirt
       for the entire beat. */
    happy.anim.talkOpen = 0.92;
    /* and on the same side as the reference, rather than the seeded
       coin-flip every wanderer gets */
    happy.anim.handed = 1;
    named.set('happy', happy);
    happyFade = 1;

    happyStopPoint(wp, wyaw);

    if (o.instant) {
      happy.root.position.copy(_hTarget);
      happy.root.rotation.y = Math.atan2(wp.x - _hTarget.x, wp.z - _hTarget.z);
      happyState = 'face';
      happyT = 0.42;                    // drops straight into `speak`
    } else {
      const s = happyStart(wp, wyaw);
      happy.root.position.set(s.x, s.y, s.z);
      happy.root.rotation.y = Math.atan2(_hTarget.x - s.x, _hTarget.z - s.z);
      happyState = 'approach';
      happyT = 0;
    }
    happy.baseYaw = happy.root.rotation.y;
    happy.anim.setMode(o.instant ? 'idle' : 'walk');
    ctx.bus?.emit('happy', { stage: happyState });
    return happy;
  }

  /** Walk him toward (x, z); returns the distance still to go. */
  function happyWalk(dt, t, tx, tz, speed) {
    const p = happy.root.position;
    _hv.set(tx - p.x, 0, tz - p.z);
    const d = _hv.length();
    if (d > 1e-3) {
      _hv.multiplyScalar(1 / d);
      const step = Math.min(speed * dt, d);
      p.x += _hv.x * step;
      p.z += _hv.z * step;
      const want = Math.atan2(_hv.x, _hv.z);
      const cur = happy.root.rotation.y;
      const dy = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
      happy.root.rotation.y = cur + dy * (1 - Math.exp(-6 * dt));
    }
    p.y = groundY(p.x, p.z);
    happy.anim.update(dt, t, { speed, turn: 0 });
    return d;
  }

  /** Turn him toward a world point. Returns the radians still to turn. */
  function happyTurnTo(dt, x, z) {
    const p = happy.root.position;
    const want = Math.atan2(x - p.x, z - p.z);
    const cur = happy.root.rotation.y;
    const dy = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
    happy.root.rotation.y = cur + dy * (1 - Math.exp(-7 * dt));
    return Math.abs(dy);
  }

  function happySay() {
    happy.anim.setMode('talk');
    happy.sayT = 1e6;                   // the beat owns his mode, not the timer
    const done = () => { if (happyState === 'speak') happyT = HAPPY.SPEAK_MAX; };
    const ui = ctx.ui;
    if (ui && ui.dialogue) {
      /* The UI agent owns the card. All this hands over is who is
         speaking and what they say — verbatim, from one constant, so
         there is exactly one copy of the line in the codebase. */
      const r = ui.dialogue({
        speaker: 'Happy',
        role: 'You have not met',
        text: HAPPY_LINE,
        portrait: 'happy',
      });
      if (r && typeof r.then === 'function') r.then(done, done);
      else done();
    } else {
      /* No UI (a bare harness): play the beat on a timer anyway, so the
         story flag can never be stranded behind a missing module. */
      api.say('happy', HAPPY_LINE, 6.0);
      setTimeout(done, 6000);
    }
    ctx.bus?.emit('happy', { stage: 'speak', line: HAPPY_LINE });
  }

  /** Swap him onto the transparent twin and drive its alpha. */
  function happySetFade(f) {
    happyFade = f;
    if (f >= 1) return;
    const m = humans.fadeMaterial();
    if (happy.body.material !== m) {
      /* EVERY MESH HE HAS, not the two this used to name. He now wears a
         printed tee and the print is a third mesh on the same shared
         clay material — miss it and the man dissolves and leaves an
         opaque elephant logo hanging in the air at chest height, which
         is a considerably worse exit than the one this whole block
         exists to avoid. humans.js publishes `meshes` for exactly this. */
      for (const mesh of (happy.meshes || [happy.body, happy.head])) {
        mesh.material = m;
        /* It is transparent now, so the normal+depth prepass would leave
           it on its own material and it would write colour into the
           buffer that the DOF and the ground shadow both read. */
        mesh.userData.noPrepass = true;
        mesh.castShadow = false;
      }
      happy._cast = false;
    }
    if (m.uniforms && m.uniforms.uFade) m.uniforms.uFade.value = f;
  }

  function happyDispose() {
    if (!happy) return;
    named.delete('happy');
    const i = all.indexOf(happy);
    if (i >= 0) all.splice(i, 1);
    happy.dispose();
    happy = null;
  }

  function happyUpdate(dt, t) {
    if (!happy || happyState === 'none' || happyState === 'done') return;
    const w = ctx.wally;
    const wp = w ? w.position : null;
    if (!wp) return;

    /* He is a story beat, so he is exempt from the LOD pass above: it
       runs before this and would have hidden or frozen him the moment
       he stepped out of the frustum mid-approach. */
    happy.root.visible = true;
    happy.active = true;
    happy.asleep = false;
    /* He looks at Wally from the moment he exists — that is most of
       what makes an approach read as being aimed at YOU. */
    happy.lookVec.set(wp.x, wp.y + 1.20, wp.z);
    happy.anim.lookTarget = happy.lookVec;
    happy.anim.lookW = damp(happy.anim.lookW || 0, happyState === 'leave' ? 0 : 1, 3.4, dt);

    switch (happyState) {
      case 'approach': {
        happyT += dt;
        /* Re-aim at the moving player, but only over the first second,
           so a player who runs in circles does not get a homing
           missile trailing him across the district. */
        if (happyT > 0.4 && happyT < 1.4) happyStopPoint(wp, w.rotation.y);
        const d = happyWalk(dt, t, _hTarget.x, _hTarget.z, HAPPY.APPROACH_SPEED);
        if (happy.root.position.distanceTo(wp) < 6.5) w.look?.(happy.byName.head, 1);
        if (d < 0.22 || happyT > 26) {
          happyState = 'face';
          happyT = 0;
          happy.anim.setMode('idle');
          ctx.bus?.emit('happy', { stage: 'face' });
        }
        break;
      }
      case 'face': {
        happyT += dt;
        const left = happyTurnTo(dt, wp.x, wp.z);
        happy.anim.update(dt, t, _still);
        w.look?.(happy.byName.head, 1);
        if ((left < 0.10 && happyT > 0.30) || happyT > 1.6) {
          happyState = 'speak';
          happyT = 0;
          happySay();
        }
        break;
      }
      case 'speak': {
        happyT += dt;
        happyTurnTo(dt, wp.x, wp.z);
        happy.anim.update(dt, t, _still);
        w.look?.(happy.byName.head, 1);
        if (happyT >= HAPPY.SPEAK_MAX) {
          /* The exit: out along the line away from Wally, turned a
             quarter off it, so he rounds away rather than reversing
             back down his own approach. */
          const p = happy.root.position;
          _hv.set(p.x - wp.x, 0, p.z - wp.z);
          if (_hv.lengthSq() < 1e-4) _hv.set(0, 0, 1);
          _hv.normalize();
          const a = Math.atan2(_hv.x, _hv.z) + 0.55;
          _hExit.set(p.x + Math.sin(a) * HAPPY.LEAVE_DIST, 0,
            p.z + Math.cos(a) * HAPPY.LEAVE_DIST);
          _hExit.y = groundY(_hExit.x, _hExit.z);
          happyState = 'leave';
          happyT = 0;
          happy.sayT = 0;
          happy.anim.setMode('walk');
          w.look?.(null);
          ctx.bus?.emit('happy', { stage: 'leave' });
        }
        break;
      }
      case 'leave': {
        happyT += dt;
        happyWalk(dt, t, _hExit.x, _hExit.z, HAPPY.LEAVE_SPEED);
        if (happy.root.position.distanceTo(wp) > HAPPY.FADE_START) {
          const t0 = HAPPY.FADE_START / HAPPY.LEAVE_SPEED;
          happySetFade(clamp(1 - (happyT - t0) / HAPPY.FADE_TIME, 0, 1));
        }
        if (happyFade <= 0.002 || happyT > 20) {
          happyDispose();
          happyState = 'done';
          ctx.bus?.emit('happy', { stage: 'done' });
          try { ctx.game?.actions?.metHappy?.(); }
          catch (e) { console.warn('[npc] metHappy threw', e); }
        }
        break;
      }
      default: break;
    }
  }

  /* THE TRIGGER IS THEIRS, NOT OURS. game.js emits this the instant the
     opening phone message is read; nothing here decides when. The
     replay-after-reload path is theirs too — story.replayHappy() emits
     the same event and lands in the same place. */
  ctx.bus?.on('story', (e) => { if (e && e.beat === 'happy') playHappy(); });

  /* ============================================================
     MAYOR KEN JONES.

     He is client `tusk` — the id is in save files, in the order book
     and in RACE.mayor, and only the name the player reads ever changed
     — so he is planned, meshed, placed, talked to and drawn in the
     phone by exactly the same machinery as the other twenty-three. What
     is here is the two things that machinery cannot know: what he LOOKS
     like, and what he does during a race.

     THE LIKENESS. There is no photograph on disk; the user's
     transcription of one IS the reference, and every field below is
     read off it in the order the eye finds them:

       the hair    a full head of THICK WHITE hair, swept back and
                   slightly tousled, receding a little at the temples.
                   It is the first thing you see and the thing that
                   reads at forty metres, so it is real geometry —
                   `swept` in humans.js, written for him — and not the
                   22 mm skullcap `receding` would have given him.
       the beard   full, white, moustache included, neatly kept, over
                   jaw and chin. `full` grows off the head's own offset
                   surface, so it follows this face's jaw rather than an
                   approximation of one.
       the face    older, broad, warm. `broad` is the widest cranium
                   with a heavy jaw, which is the one a full beard sits
                   on properly; `age: 2` puts the laughter lines in and
                   `mood: 'warm'` tilts the brows up rather than down.
                   He is a civic man and a friendly one, not a villain.
       the skin    warm, RUDDY, pink-toned. None of the eight stock
                   tones is pink — they all run yellow-warm — so he
                   carries his own {b,s,d,l}. See humans.js `skinTone`
                   for why that is an override and not a ninth row.
       the clothes a dark navy BUTTON-UP shirt. The button placket is
                   the thing that makes it a shirt rather than a jersey,
                   and it is painted the way the jacket is (humans.js
                   `placket`), because 1.5 mm of doubled cloth cannot be
                   meshed on a 21.5 mm shared cell.
       the height  TALL, per the user, and broad in the shoulder.
                   1.24 stature is 2.08 m against a 1.70 m median and
                   the `heavy` body carries the shoulders. This is not
                   decoration: it is how you find him in a race.

     THE HAT GOES. data.js dresses him in a top hat, which was the old
     joke-mayor, and a top hat covers the one feature the description
     leads with. Nothing else about the data row is touched — the same
     record still drives his orders, his patience, his budget and his
     name.
     ============================================================ */
  const MAYOR_ID = RACE?.mayor || 'tusk';

  const MAYOR_LOOK = {
    face: 'broad',
    hair: 'swept',
    hairCol: 'white',
    beard: 'full',
    specs: 'none',
    hat: 'none',
    age: 2,
    mood: 'warm',
    /* ruddy, pink-toned, warm — and light enough that a white beard
       still reads as white against it */
    skinTone: { b: 0xecb3a3, s: 0xd0887b, d: 0xa5645a, l: 0xf9d2c5 },
    /* DARK NAVY, NOT BLACK-BLUE. A shirt is the largest single field of
       colour on a human and it is multiplied three more times before it
       reaches the screen — by its own baked AO, by the shade band and by
       whatever cast shadow he is standing in. A true midnight navy
       lands under #0a0e1c on the shaded flank, which §7 forbids
       outright. 0x33405f reads unmistakably navy at noon and still has
       a hue left in it at dusk. */
    shirtCol: 0x33405f,
    placket: 0.022,
    trouserCol: 0x4a4a52,
    shoeCol: 0x5a4b42,
    build: 1.14,             // broad-shouldered: picks the `heavy` body
    stature: 1.24,           // TALL — 2.08 m against a 1.70 m median
  };

  /* HIS FACE IN 2D, WHEREVER ONE IS DRAWN. ui/style.js has its own
     vocabulary of seventeen hair paths and no `swept`; `short` is the
     one that means the same thing there — a full cap of hair — and in
     white at 34-66 px that is exactly what the description says. The
     registration is the same shallow-copy path Happy uses (see
     registerPortrait) and for the same reason: DATA is deep-frozen, and
     an avatar that silently disagrees with the model standing in the
     street is worse than a cross-layer write that says so out loud.
     THIS BELONGS IN data.js. Delete it when the data agent adopts it. */
  function mayorPortraitRecord(c) {
    return {
      ...c,
      hair: 'short', hairCol: 'white', beard: 'full',
      hat: 'none', specs: 'none', skin: 'porcelain',
      age: 2, mood: 'warm',
    };
  }
  let mayorPortraitDone = false;
  function registerMayorPortrait() {
    if (mayorPortraitDone) return false;
    const game = ctx.game;
    const data = game?.data;
    const reg = data?.clientById;
    if (!reg) return false;
    mayorPortraitDone = true;
    const c = reg[MAYOR_ID];
    if (!c) return false;
    if (c.hair === 'short' && c.hairCol === 'white') return true;   // adopted
    const rec = mayorPortraitRecord(c);
    try {
      reg[MAYOR_ID] = rec;
      if (reg[MAYOR_ID] === rec) return true;
      game.data = { ...data, clientById: { ...reg, [MAYOR_ID]: rec } };
      return ctx.game?.data?.clientById?.[MAYOR_ID] === rec;
    } catch (e) {
      try {
        game.data = { ...data, clientById: { ...reg, [MAYOR_ID]: rec } };
        return ctx.game?.data?.clientById?.[MAYOR_ID] === rec;
      } catch (e2) { return false; }
    }
  }

  /* ------------------------------------------------------------------
     THE RACE, AS PRESENTATION.

     THE SPLIT, and it is the same one Happy's beat is built on. The
     rules agent owns WHETHER and HOW FAST: game.race.start() returns
     {mps, mayorSeconds, route} and emits bus 'race' with the same
     payload, game.race.checkpoint(i) counts the rings, game.race.finish()
     judges it, and game.race.hint() decides when anybody is allowed to
     mention a scooter. NOTHING HERE DECIDES ANY OF THAT. What is here
     is where the man is on the island while it happens, how fast his
     legs go round, and what he says as he goes past.

     HE RUNS THE ROADS, NOT THE CROW'S LINE. Interpolating between the
     five route locations would run him through the Market Hall and over
     a hedge. crowd.js already holds the road graph — the same relaxed,
     terrain-carved polylines the ribbons are drawn on — so the legs are
     routed over it with a Dijkstra and stitched into one polyline. The
     search runs once per race, over ~40 nodes, and costs well under a
     millisecond.

     HE IS PACED BY THE RULE, NOT BY A GUESS. `mps` from the payload IS
     his speed, so the man on screen arrives when the clock underneath
     says he arrives. If the route is longer or shorter than the rules
     layer's straight-line metres — it is longer, roads bend — his speed
     is scaled by the ratio so that he still finishes at mayorSeconds.
     A Mayor who beats his own published time is a bug the player can
     see.
     ------------------------------------------------------------------ */
  const MAYOR = {
    RUN_ANIM: 'run',
    LEAD_IN: 1.1,           // seconds of him on the line before he goes
    LINGER: 6.0,            // how long he stays put after he finishes
    NEAR_TALK: 26,          // he only calls out if you can see him
  };
  /* What he says, and when. Short, dry, unbothered — he is a sixty-year
     -old man in a shirt who runs this route every week and knows it. */
  const MAYOR_LINES = {
    start: ['Try to keep up, Wally.', 'Off we go then!', 'Mind the noodle carts.'],
    mid: ['Still with me?', 'Lovely morning for it!', 'I do this every Tuesday.',
      'Left at the bank. Always left at the bank.'],
    behind: ['Take your time!', 'I will wait at the Spoon.', 'No hurry at all.'],
    ahead: ['Oh, well done.', 'Right. RIGHT.', 'Now you are just showing off.'],
  };

  let mayor = null;
  let mayorState = 'none';      // none|ready|run|finish
  let mayorT = 0;
  let mayorPath = null;         // [{x,z}, ...] the stitched road route
  let mayorLen = 0;
  let mayorDist = 0;
  let mayorSpeed = 0;
  let mayorSayT = 0;
  let mayorFrozen = false;
  const _mv = new THREE.Vector3();

  /** Ensure he exists, meshed, wherever he is standing. */
  function ensureMayor() {
    mayor = named.get(MAYOR_ID) || ensure(MAYOR_ID);
    return mayor;
  }

  /* ---- the road router ---- */
  let ADJ = null;
  function adjacency() {
    if (ADJ) return ADJ;
    const nodes = crowd.nodes || [];
    ADJ = nodes.map(() => []);
    for (const e of (crowd.edges || [])) {
      if (!e.points || e.points.length < 2) continue;
      let len = 0;
      for (let i = 1; i < e.points.length; i++) {
        len += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
      }
      if (!ADJ[e.a.i] || !ADJ[e.b.i]) continue;
      ADJ[e.a.i].push({ to: e.b.i, e, fwd: true, len });
      ADJ[e.b.i].push({ to: e.a.i, e, fwd: false, len });
    }
    return ADJ;
  }
  function nodeOfLoc(id) {
    const nodes = crowd.nodes || [];
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].kind === 'loc' && nodes[i].ref && nodes[i].ref.id === id) return i;
    }
    return -1;
  }
  /** Shortest road walk between two graph nodes, as a list of points. */
  function roadLeg(from, to) {
    const adj = adjacency();
    if (from < 0 || to < 0 || !adj[from]) return null;
    const N = adj.length;
    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const via = new Array(N).fill(null);
    const seen = new Uint8Array(N);
    dist[from] = 0;
    /* A linear scan for the minimum. N is about forty and this runs five
       times per race — a binary heap here would be more code than it
       could ever save. */
    for (let it = 0; it < N; it++) {
      let u = -1, bd = Infinity;
      for (let i = 0; i < N; i++) if (!seen[i] && dist[i] < bd) { bd = dist[i]; u = i; }
      if (u < 0 || u === to) break;
      seen[u] = 1;
      for (const l of adj[u]) {
        const nd = dist[u] + l.len;
        if (nd < dist[l.to]) { dist[l.to] = nd; prev[l.to] = u; via[l.to] = l; }
      }
    }
    if (!Number.isFinite(dist[to])) return null;
    const chain = [];
    for (let n = to; n !== from && n >= 0; n = prev[n]) {
      if (!via[n]) return null;
      chain.unshift(via[n]);
    }
    const out = [];
    for (const l of chain) {
      const pts = l.fwd ? l.e.points : [...l.e.points].reverse();
      for (const p of pts) {
        const last = out[out.length - 1];
        if (last && Math.hypot(last.x - p.x, last.z - p.z) < 0.4) continue;
        out.push({ x: p.x, z: p.z });
      }
    }
    return out.length > 1 ? out : null;
  }
  /** The whole dash, as one polyline over the road network. */
  function buildMayorPath(route) {
    const ids = (route && route.length ? route : (RACE?.route || [])).map((r) => r.loc || r);
    const pts = [];
    for (let i = 1; i < ids.length; i++) {
      const leg = roadLeg(nodeOfLoc(ids[i - 1]), nodeOfLoc(ids[i]));
      if (leg) {
        for (const p of leg) {
          const last = pts[pts.length - 1];
          if (last && Math.hypot(last.x - p.x, last.z - p.z) < 0.4) continue;
          pts.push(p);
        }
      } else {
        /* no road between them — the straight line is still better than
           standing still, and this is the branch that keeps a broken or
           half-built path network from breaking the race */
        const a = LOCATIONS.find((l) => l.id === ids[i - 1]);
        const b = LOCATIONS.find((l) => l.id === ids[i]);
        if (a && b) {
          if (!pts.length) pts.push({ x: a.world.x, z: a.world.z });
          pts.push({ x: b.world.x, z: b.world.z });
        }
      }
    }
    /* HE RUNS PAST THE DOOR, NOT THROUGH THE LOBBY. A location's graph
       node sits at the location's CENTRE — which is the building — so
       the lane polylines that terminate on one run straight into the
       middle of the Market Hall. Following them put both the Mayor and
       the shot's camera inside a wall; the first two attempts at this
       screenshot are a full frame of interior plaster.

       So every point is pushed out of every building footprint it is
       inside, radially, to the rim plus a stride. The route still
       visits each corner of the Dash — it now rounds it, the way a
       runner rounds a corner, instead of taking the reception desk. */
    for (const p of pts) {
      for (const l of LOCATIONS) {
        const r = Math.max(l.size?.w || 8, l.size?.d || 8) * 0.5 + 1.8;
        const dx = p.x - l.world.x, dz = p.z - l.world.z;
        const d = Math.hypot(dx, dz);
        if (d < r) {
          if (d < 1e-3) { p.x += r; continue; }
          p.x = l.world.x + (dx / d) * r;
          p.z = l.world.z + (dz / d) * r;
        }
      }
    }
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    }
    return { pts, len };
  }

  /** Where he is, `d` metres into the route. Writes into `_mv`. */
  function mayorAt(d, out) {
    const pts = mayorPath;
    if (!pts || pts.length < 2) return out.set(0, 0, 0);
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) || 1e-4;
      if (acc + seg >= d || i === pts.length - 1) {
        const t = clamp((d - acc) / seg, 0, 1);
        const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
        const z = pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t;
        return out.set(x, groundY(x, z), z);
      }
      acc += seg;
    }
    return out.set(pts[0].x, groundY(pts[0].x, pts[0].z), pts[0].z);
  }

  function mayorSay(pool) {
    if (!mayor || !bubbles) return;
    const line = pool[Math.floor(bubbleRng() * pool.length) % pool.length];
    bubbles.show(mayor, line, { key: 'mayor', ttl: 3.8, tint: '#c98a3a' });
  }

  /**
   * Put him on the start line and set him running.
   * @param {{mps?:number, mayorSeconds?:number, route?:Array, demo?:boolean}} o
   */
  function startMayorRun(o = {}) {
    const h = ensureMayor();
    if (!h) return null;
    const built = buildMayorPath(o.route || ctx.game?.race?.route?.());
    if (!built.pts.length) return null;
    mayorPath = built.pts;
    mayorLen = built.len;
    mayorDist = 0;
    /* PACED BY THE RULE. The rules layer's metres are straight-line
       between locations; the road is longer, so his metres-per-second is
       scaled to land him on the same finishing time. */
    const secs = o.mayorSeconds || ctx.game?.race?.pace?.().mayorSeconds || 0;
    const mps = o.mps || ctx.game?.race?.pace?.().mps || 4.4;
    /* AND CLAMPED, because the two lengths do not agree. The rules
       layer's metres are STRAIGHT LINES between five locations — 790 m
       — and the roads that actually join them are 1330 m. Solving
       mayorLen / mayorSeconds exactly therefore asked a sixty-year-old
       in a shirt to run at 8.3 m/s, which is world-record pace and
       reads, correctly, as a bug. He is held to a fast but human 6.2
       m/s instead. The RESULT is unaffected — game.race.finish() judges
       the UI's clock against the rule's own number and never looks at
       where this man is standing — so what is being traded is a
       cosmetic agreement between two lengths for a Mayor who moves like
       a person. */
    mayorSpeed = clamp(secs > 0 ? mayorLen / secs : mps, 3.2, 6.2);
    mayorState = 'ready';
    mayorFrozen = false;
    mayorT = 0;
    mayorSayT = 2.2;
    h.exempt = true;
    h.mayorDriven = true;
    h.asleep = false;
    h.active = true;
    h.root.visible = true;
    mayorAt(0, _mv);
    h.root.position.copy(_mv);
    h.anim.setMode('idle');
    h.anim.lookTarget = null;
    h.anim.lookW = 0;
    if (h.agent) { h.agent.frozen = true; h.agent.speed = 0; }
    return { len: +mayorLen.toFixed(1), mps: +mayorSpeed.toFixed(2), points: mayorPath.length };
  }

  function stopMayorRun(where) {
    if (!mayor) return;
    mayorState = 'finish';
    mayorT = 0;
    mayor.anim.setMode('idle');
    if (where) mayorSay(where);
  }

  function mayorUpdate(dt, t) {
    if (!mayor || mayorState === 'none') return;
    const h = mayor;
    h.root.visible = true;
    h.active = true;
    h.asleep = false;
    const wp = ctx.wally ? ctx.wally.position : null;

    switch (mayorState) {
      case 'ready': {
        mayorT += dt;
        h.anim.update(dt, t, _still);
        if (mayorT === dt && wp) mayorSay(MAYOR_LINES.start);
        if (mayorT >= MAYOR.LEAD_IN) { mayorState = 'run'; mayorT = 0; h.anim.setMode(MAYOR.RUN_ANIM); }
        break;
      }
      case 'run': {
        mayorT += dt;
        /* FROZEN IS FOR THE CAMERA, NOT FOR THE GAME. tools/shot.mjs
           runs its --eval and THEN waits out the settle time, so a
           Mayor posed for a screenshot is eighty metres up the road by
           the time the shutter opens. Frozen holds his position and
           keeps his legs turning, which is what a still of a run needs.
           Nothing sets it but a debug hook. */
        if (!mayorFrozen) mayorDist += mayorSpeed * dt;
        const prevX = h.root.position.x, prevZ = h.root.position.z;
        mayorAt(Math.min(mayorDist, mayorLen), _mv);
        h.root.position.copy(_mv);
        const dx = _mv.x - prevX, dz = _mv.z - prevZ;
        if (dx * dx + dz * dz > 1e-6) {
          const want = Math.atan2(dx, dz);
          const cur = h.root.rotation.y;
          const dy = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
          h.root.rotation.y = cur + dy * (1 - Math.exp(-6 * dt));
        }
        h.anim.update(dt, t, { speed: mayorSpeed, turn: 0 });
        /* HE CALLS OUT, but only when he is close enough for you to have
           heard it, and never twice inside eight seconds. */
        mayorSayT -= dt;
        if (mayorSayT <= 0 && wp) {
          mayorSayT = 8 + bubbleRng() * 7;
          const d = h.root.position.distanceTo(wp);
          if (d < MAYOR.NEAR_TALK) {
            /* is he ahead of Wally on the route, or behind? Distance
               from the finish is the honest measure of that. */
            mayorAt(mayorLen, _mv);
            const mine = mayorLen - mayorDist;
            const yours = wp.distanceTo(_mv);
            mayorSay(mine < yours - 12 ? MAYOR_LINES.behind
              : mine > yours + 12 ? MAYOR_LINES.ahead : MAYOR_LINES.mid);
          }
        }
        if (mayorDist >= mayorLen && !mayorFrozen) stopMayorRun(null);
        break;
      }
      case 'finish': {
        mayorT += dt;
        h.anim.update(dt, t, _still);
        if (wp && h.root.position.distanceTo(wp) < 14) {
          h.lookVec.set(wp.x, wp.y + 1.2, wp.z);
          h.anim.lookTarget = h.lookVec;
          h.anim.lookW = damp(h.anim.lookW || 0, 1, 3, dt);
        }
        if (mayorT > MAYOR.LINGER) {
          mayorState = 'none';
          h.mayorDriven = false;
          h.exempt = false;
          /* home is where he was standing before the Mayor's Dash */
          if (h.home) { h.root.position.copy(h.home); h.root.rotation.y = h.baseYaw; }
          h.anim.setMode(h.baseMode || 'idle');
        }
        break;
      }
      default: break;
    }
  }

  /* THE RULES LAYER OWNS THE RACE. Every one of these is a report of
     something that has already been decided elsewhere. */
  ctx.bus?.on('race', (e) => {
    if (!e) return;
    if (e.kind === 'offer') { registerMayorPortrait(); ensureMayor(); return; }
    if (e.kind === 'start') {
      registerMayorPortrait();
      startMayorRun({ mps: e.mps, mayorSeconds: e.mayorSeconds, route: e.route });
      return;
    }
    if (e.kind === 'abandon') { stopMayorRun(null); return; }
    if (e.kind === 'finish') {
      stopMayorRun(e.won ? MAYOR_LINES.ahead : MAYOR_LINES.behind);
      return;
    }
    if (e.kind === 'hint') sayHint(e.text);
  });

  /* ============================================================
     BULL AND BEAR — the city talking as it walks past.

     The pool of lines and the drawing both live in bubbles.js. What is
     here is the SCHEDULING, because only this module knows who is on
     screen, who is walking, who spoke last and how far away the camera
     is.

     WHO GETS A LINE. Somebody in the crowd, between 5 and 22 metres
     out, currently animated (so they are in frame and near enough to
     have their skeleton written), who has not spoken in a minute. A
     walker is preferred over a stander two to one: the brief asks for
     NPCs walking BY, and a line over somebody who is going somewhere
     reads as overheard, while a line over somebody stationary reads as
     a shopkeeper's sign.

     HOW OFTEN. One every 4.5 to 9 seconds at most, and bubbles.js caps
     how many can be on screen and refuses any that would overlap one
     that is already up. On a quiet street that is a line every few
     seconds; in a crowded market square it is the same rate, which is
     the point — the frequency is a property of the PLAYER, not of the
     population, or a busy district would turn into a wall of text.

     THE SEED. A dedicated stream, so two runs of the same build
     overhear the same city in the same order and a screenshot is
     reproducible.
     ============================================================ */
  const bubbles = createBubbles(ctx, {});
  const bubbleRng = ctx.makeRng('npc.bubbles.v1');
  let bubbleT = 3.0;
  let hintPokeT = 20;
  /* THE PICKER GETS ITS OWN STREAM. It draws a variable number of
     values per line (the recency scan is a reservoir sample), and
     bubbleRng also scores the candidate crowd — sharing one stream
     would make WHO speaks depend on how full the line memory happened
     to be, which is exactly the kind of coupling that makes a
     screenshot stop reproducing. */
  const linePicker = createLinePicker(ctx.makeRng('npc.bubbles.lines.v2'));

  /* ------------------------------------------------------------
     THE SCENE — everything the picker is allowed to know.

     Built from the SPEAKER, not from the player: the district is the
     one that person is standing in. Everything is read through
     optional chaining and defaulted, because npc.js boots before
     game.js and the first few frames have no rules layer at all.

     The sky is read as `rainfall`/`storminess` and never as
     `weatherName` — see sky.js: the name is what was ASKED for and a
     transition takes 150 seconds, so a citizen keyed off the name
     complains about rain two minutes before the first drop lands.
     ------------------------------------------------------------ */
  function sightingNow() {
    const w = ctx.wally;
    if (!w) return null;
    if (w.flying) return 'balloon';
    if (w.riding) {
      const id = w.rideId;
      return id === 'motorcycle' || id === 'scooter' ? id : 'bike';
    }
    return null;
  }

  const _scene = {};
  function sceneFor(h) {
    const p = h?.root?.position;
    let zone = null;
    if (p && ctx.world?.zoneAt) {
      try { zone = ctx.world.zoneAt(p.x, p.z)?.id ?? null; } catch (e) { zone = null; }
    }
    _scene.zone = zone;
    _scene.hour = ctx.game?.time?.hour ?? 12;
    _scene.rainfall = ctx.sky?.rainfall ?? 0;
    _scene.storminess = ctx.sky?.storminess ?? 0;
    let pct = 0, rep = 0;
    try { pct = ctx.game?.economy?.cityPct?.() ?? 0; } catch (e) { pct = 0; }
    try { rep = ctx.game?.rep?.()?.rep ?? 0; } catch (e) { rep = 0; }
    _scene.pct = pct;
    _scene.rep = rep;
    _scene.seeing = sightingNow();
    /* THE FIRST TIME THE BALLOON GOES UP, the city is not asked to
       roll for it. After that it is one remark among many. */
    _scene.forceSeeing = balloonBurst > 0 && _scene.seeing === 'balloon';
    return _scene;
  }

  function pickLine(h) {
    return linePicker.pick(sceneFor(h));
  }

  /* `loose` skips the ANIMATED test. h.active is written by the LOD
     pass at the top of update(), i.e. against LAST frame's camera — so
     a debug hook that has just moved the camera finds nobody animated
     anywhere near it and returns null. In gameplay the strict test is
     the right one: a person whose skeleton is frozen is a person the
     frustum or the budget has already given up on. */
  const _fwd = new THREE.Vector3();
  function bubbleCandidate(camPos, loose) {
    let best = null, bestScore = -1e9;
    /* IN FRONT OF THE LENS, and this is not an optimisation. bubbles.js
       rejects anything that projects behind the camera — it has to, or a
       balloon appears mirrored on the wrong side of the screen — so a
       candidate chosen from behind is a granted line that is silently
       thrown away, and the anti-spam timer has already been spent on
       it. Measured: at Market Hall the nearest six people were all
       behind the camera and the feature produced nothing at all. */
    ctx.camera.getWorldDirection(_fwd);
    for (const h of all) {
      if (h.asleep) continue;
      if (!loose && (!h.active || !h.root.visible)) continue;
      if (h.isClient || h.mayorDriven || h === happy) continue;
      if ((h.bubbleAt ?? -1e9) > elapsed - 55) continue;
      const d = h.root.position.distanceTo(camPos);
      if (d < 5 || d > 22) continue;
      if (((h.root.position.x - camPos.x) * _fwd.x
        + (h.root.position.z - camPos.z) * _fwd.z) / d < 0.30) continue;
      const moving = h.agent && h.agent.speed > 0.5;
      /* nearest first, walkers weighted up, plus a little noise so the
         same person is not always the one who talks */
      const s = -d + (moving ? 9 : 0) + bubbleRng() * 4;
      if (s > bestScore) { bestScore = s; best = h; }
    }
    return best;
  }

  /** The scooter hint, on whoever is nearest — the rules layer decided
      that this is allowed to be said; this only finds a mouth for it. */
  let pendingHint = null, pendingHintT = 0;
  function sayHint(text) {
    if (!text) return false;
    pendingHint = text;
    pendingHintT = 12;          // keep trying for twelve seconds
    return true;
  }
  function hintUpdate(dt, camPos) {
    if (!pendingHint) return;
    pendingHintT -= dt;
    if (pendingHintT <= 0) { pendingHint = null; return; }
    const h = bubbleCandidate(camPos, true) || api.nearest(camPos, 24);
    if (!h || h.mayorDriven) return;
    if (bubbles.show(h, pendingHint, { ttl: 6.0, tint: '#f5913c', key: 'hint' })) {
      h.bubbleAt = elapsed;
      h.anim.setMode('talk');
      h.sayT = 3.0;
      pendingHint = null;
    }
  }

  /* ============================================================
     THE CITY LOOKS UP.

     The remark is only half of noticing. A speech bubble is a
     gameplay-distance object by construction — nothing speaks past
     thirty metres and no line is granted to anyone more than
     twenty-two metres from the lens — so once the balloon is properly
     up, TEXT CANNOT REACH IT. Two lines at the moment he leaves the
     ground, and then, correctly, silence.

     What carries at sixty metres is posture. So the street tilts its
     head back instead: HumanAnim already has a look-at with a chest
     follow-through, nothing in the crowd was ever using it, and one
     Vector3 per active pedestrian per frame buys the whole city
     watching him go. THE SPLIT IS THE DESIGN — text near the ground,
     posture at altitude — and it is the reason the balloon lines are
     worth writing at all when a player only hears them for a few
     seconds of a flight.

     AND THEN IT WAS MEASURED FROM THE WRONG CAMERA, WHICH IS WORSE
     THAN NOT MEASURING IT.

     "Head pitch 26 to 40 degrees, 15 or 16 of about 25 people looking
     up, at 34 m altitude" is a real reading and it is reproducible —
     from a STREET camera with the balloon parked overhead, which is
     what bubbleCam({keepWally:true}) leaves you holding and what that
     figure was taken through. A player is never in that configuration:
     the flight rig claims the lens the moment he lifts off. Driven
     through the real flight camera instead (tools/gawkladder.mjs,
     Market Hall and Main Street, 13:00, arrive() asserted):

       alt      6 m   12 m   19 m   26 m   34 m   45 m   60 m
       looking   13      6      0      0      0      0      0
       animated  18      8      0      0      0      0      0

     Both readings are of the same code and neither is wrong. What
     they disagree about is the LENS, and the lens is what h.active is
     computed against — it is a render-LOD flag (frustum AND within
     ANIM_FAR of the camera AND under the head-count budget), and the
     gawk pass was gated on it. From the basket the near crowd is
     under the bottom edge of the frame and the far crowd is past
     62 m, so `active` is zero and there is nobody to ask. Two things
     had to change and neither of them is in this file's design: the
     reach (see the LOD block in update()) and the notice radius,
     which was a flat 70 m — the distance from which somebody notices
     a balloon cannot be smaller than the distance at which the game
     is willing to animate him.

     AND POSTURE IS NOT A NECK, AT THE SIZE THIS IS SEEN AT. At 6 m
     the craning head is the whole gesture and it is lovely. At the
     range the flight camera actually frames — 60 to 160 m, a person
     9 to 15 px tall — a 40-degree head tilt is a fraction of a pixel
     on a two-pixel skull. What survives is the silhouette and the
     motion field: so somebody who notices STOPS for three or four
     seconds, TURNS, and about a third of them POINT. Fifteen figures
     that were sliding along a street all stopping is legible at nine
     pixels; a raised arm is legible at fifteen. The craning stays
     exactly as it was, because it is still the read close up.

     NOT EVERYBODY AND NOT AT ONCE. A little over a quarter never look
     up (they have things to do), and the rest turn over a staggered
     two seconds, because a crowd that snaps its heads in unison is a
     Mexican wave, not a city. The bias is drawn once per person from a
     seeded stream, so the same people look up in the same order every
     run and a screenshot reproduces.

     IT TOUCHES ONLY CROWD WALKERS. Named clients, and anyone the debug
     lineup froze, are driven by the standers pass above, which owns
     their look-at. Two writers on one field is how a head ends up
     vibrating between two targets.
     ============================================================ */
  const gawkRng = ctx.makeRng('npc.gawk.v1');
  const _gawkTo = new THREE.Vector3();
  let balloonBurst = 0;
  let flyWas = false, gawk = 0, gawkT = 0, gawkLive = false, gawkers = 0;
  let pointers = 0, stoppers = 0;
  /** The old flat gate, kept as the FLOOR. On the ground `noticeR` is
      exactly this and nothing about the crowd changes. */
  const GAWK_R = 70;
  /** Rewritten every frame by update(), before this pass runs. */
  let noticeR = GAWK_R;
  /* THE RUNTIME REVERT (contracts.js rule 1). 'flat' is the rule that
     shipped before this round — ANIM_FAR is 62 m and the notice radius
     is 70 m at every altitude — and 'lens' is the one that ships now.
     Both are driven on ONE page load by tools/voicetest.mjs, because a
     quoted before-number is a citation and not a check. */
  let gawkReach = 'lens';

  /** Give one person's head back to whoever normally owns it. */
  function release(h) {
    if (!h.gawkOn) return;
    h.gawkOn = false;
    h.lookW = 0;
    if (h.anim) { h.anim.lookW = 0; h.anim.lookTarget = null; h.anim.pointW = 0; }
    /* the stare is seconds, not a latch, so it expires on its own —
       but a person released mid-stare must walk on now, not in three
       seconds' time */
    if (h.agent) h.agent.stare = 0;
  }

  function gawkUpdate(dt, wp) {
    const flying = !!(ctx.wally && ctx.wally.flying);
    if (flying && !flyWas) {
      /* HE HAS JUST LEFT THE GROUND. The next remark comes early, and
         the two after it are balloon lines rather than a roll for one. */
      balloonBurst = 2;
      bubbleT = Math.min(bubbleT, 1.4);
      gawkT = 0;
      gawkLive = true;
    }
    flyWas = flying;
    if (!gawkLive || !wp) return;
    gawkT += dt;
    gawk = damp(gawk, flying ? 1 : 0, 2.0, dt);
    if (!flying && gawk < 0.005) gawk = 0;
    _gawkTo.set(wp.x, wp.y + 1.1, wp.z);   // the basket, not his feet
    gawkers = 0; pointers = 0; stoppers = 0;
    for (const h of all) {
      /* `h.active` MEANS "HIS SKELETON IS BEING SOLVED", AND THAT IS
         NOT THE SAME QUESTION AS "CAN HE SEE THE BALLOON". Gating the
         notice on it is what tied noticing to the animation budget —
         46 people, nearest first, none of them in the picture from a
         balloon — and it is the second half of why the city never
         looked up. `h.airOn` is the other way a person is on screen:
         drawn as an instance, no bones, and every visible cue he has
         (stopping, turning, the pale upturned face) is one this pass
         writes. Both are "he is in the picture"; only one costs a
         skeleton. */
      const eligible = (h.active || h.airOn) && !h.mayorDriven && h !== happy && !h.asleep;
      if (eligible && h.gawkBias === undefined) h.gawkBias = gawkRng();
      let want = 0;
      if (eligible && h.gawkBias <= 0.72) {
        const d = h.root.position.distanceTo(_gawkTo);
        if (gawk > 0.01 && d < noticeR && gawkT > 0.35 + h.gawkBias * 2.1) want = gawk;
      }
      /* NEVER CLAIM SOMEBODY WE DO NOT ALREADY OWN. A person the
         standers pass has looking at Wally still carries look weight
         when he lifts off; without this test one of the people who
         DOES NOT look up (bias > 0.72) would be claimed on that
         leftover weight and quietly aimed at the balloon anyway. */
      if (want <= 0 && !h.gawkOn) continue;
      if (want <= 0 && h.lookW <= 0.002) { release(h); continue; }
      /* ---- THE MOMENT HE NOTICES, and it happens exactly once ----
         Three to six and a half seconds of standing still and turning
         to face it, drawn off the same per-person bias that staggered
         the head turn, so the stopping is staggered by construction
         and the street empties of motion over two seconds rather than
         on one frame. crowd.js declines the stop outright if he is
         standing in a doorway keep-clear, so this cannot manufacture
         a blocker the eviction pass then has to remove. */
      const first = !h.gawkOn;
      h.gawkOn = true;
      if (first && h.agent) {
        /* THE EAGER ONES WATCH LONGEST, which is the same fact as
           noticing first and is drawn off the same number. Tying the
           duration to the bias the other way round — which is the way
           it was first written — gave the shortest stop to the people
           who look up first, so the pointers (also the low bias, see
           below) had their arms down again before anybody else had
           got theirs up. Measured, that was 0 pointers in every row of
           the altitude ladder. */
        h.agent.stare = 3.4 + (0.72 - h.gawkBias) * 4.4;
        h.agent.stareX = _gawkTo.x; h.agent.stareZ = _gawkTo.z;
      }
      h.lookW = damp(h.lookW, want, 2.6, dt);
      h.lookVec.copy(_gawkTo);
      h.anim.lookTarget = h.lookVec;
      h.anim.lookW = h.lookW;
      /* ---- and about a third of them point ----
         The bias is already a uniform draw over [0, 0.72] for everyone
         who looks up at all, so its bottom third IS a third of them,
         with no second stream and no second field on the record. The
         arm goes up with the stop and comes down with it: an arm held
         out for the whole flight is a statue, and the flight is
         minutes long. */
      const pointing = h.gawkBias < 0.24 && h.agent && h.agent.stare > 0.4;
      h.anim.pointW = pointing ? h.lookW : 0;
      if (h.lookW > 0.3) gawkers++;
      if (pointing && h.lookW > 0.3) pointers++;
      if (h.agent && h.agent.stare > 0) stoppers++;
    }
    /* AND HAND EVERYBODY BACK WHEN IT IS OVER, on the same frame the
       ramp closes. `gawkOn` is what tells the standers pass to keep its
       hands off a head; a crowd walker has no other writer, so one left
       set with a stale target is a pedestrian who stares at an empty
       patch of sky for the rest of the session. It cost a rewrite of
       this loop to make every exit path go through release(). */
    if (gawk === 0) { gawkLive = false; for (const h of all) release(h); }
  }

  function bubbleUpdate(dt, t, camPos) {
    bubbles.update(dt, t);
    hintUpdate(dt, camPos);
    if (ctx.ui?.modal || ctx.ui?.dialogueOpen) return;

    /* THE HINT IS THE RULES LAYER'S TO GIVE. game.race.hint() is the
       whole gate — never before the second loss, never twice in a day,
       and then only about a third of the time — so this does nothing
       but ASK, occasionally, and obey the answer. It returns null far
       more often than not, which is exactly the intent. */
    hintPokeT -= dt;
    if (hintPokeT <= 0) {
      hintPokeT = 45 + bubbleRng() * 30;
      const race = ctx.game?.race;
      if (race && !pendingHint && race.status?.() === 'lost') {
        try { race.hint(); } catch (e) { /* the rules layer said no */ }
      }
    }

    bubbleT -= dt;
    if (bubbleT > 0) return;
    bubbleT = 4.5 + bubbleRng() * 4.5;
    const h = bubbleCandidate(camPos);
    if (!h) return;
    if (bubbles.show(h, pickLine(h), {})) { h.bubbleAt = elapsed; if (balloonBurst > 0) balloonBurst--; }
  }

  /* ------------------------------------------------------------
     ctx.npc
     ------------------------------------------------------------ */
  const api = {
    root,
    material: humans.material,
    humans: all,
    named,
    crowd,

    /** Spawn a named client (or any human by spec id). */
    spawn(clientId, pos) { return spawnClient(clientId, pos); },

    /** Add `n` anonymous wanderers to the road network. */
    spawnCrowd(n) { return planCrowd(n | 0); },

    /** Mesh everything still queued, now. The screenshot harness and
        any test that wants a settled world calls this rather than
        guessing at how many frames the streamer needs. */
    drain() { while (pending.length) buildRec(pending.shift()); return all.length; },

    /** How many people are still queued for construction. */
    get queued() { return pending.length; },

    /** Everyone standing at (or wandering through) a location. */
    at(locId) {
      const l = LOCATIONS.find((x) => x.id === locId);
      if (!l) return [];
      const r = Math.max(14, (l.radius || 10) * 1.6);
      const out = [];
      for (const h of all) {
        const dx = h.root.position.x - l.world.x, dz = h.root.position.z - l.world.z;
        if (dx * dx + dz * dz < r * r) out.push(h);
      }
      return out;
    },

    /** Nearest human to a point. */
    nearest(pos, radius = 6) {
      let best = null, bd = radius * radius;
      for (const h of all) {
        const d = h.root.position.distanceToSquared(pos);
        if (d < bd) { bd = d; best = h; }
      }
      return best;
    },

    /** Point someone's head at a world position (or null to release). */
    lookAt(id, target) {
      const h = ensure(id);
      if (!h) return null;
      if (!target) { h.anim.lookTarget = null; h.anim.lookW = 0; h.lookW = 0; return h; }
      h.anim.lookTarget = target.isVector3 ? target.clone()
        : new THREE.Vector3(target.x, target.y ?? 1.4, target.z);
      h.anim.lookW = 1; h.lookW = 1;
      return h;
    },

    /** A line over their head, and a gesture to go with it. */
    say(id, text, ttl = 3.6) {
      const h = ensure(id);
      if (!h || !ctx.ui) return null;
      const p = h.root.position.clone();
      p.y += h.height * 1.08;
      ctx.ui.prompt(text, p, { id: 'npc.say.' + id, key: '•', ttl });
      h.anim.setMode('talk');
      h.sayT = ttl;
      return h;
    },

    /** Open the client dialogue for a named client. */
    talk(id) {
      const h = ensure(id);
      if (!h || !h.client) return null;
      if (ctx.ui?.talkTo) ctx.ui.talkTo(h.client);
      h.anim.setMode('talk');
      h.sayT = 4;
      return h;
    },

    /** The bubble pool — bubbles.show(human, text) puts a line over
        anybody, and the line pools are on it (bull / bear / street). */
    bubbles,
    /** A line over one named client, through the bubble system rather
        than the world-space prompt. */
    bubble(id, text, o) {
      const h = ensure(id);
      return h ? bubbles.show(h, text, o || { force: true }) : false;
    },

    /* --- Mayor Ken Jones, and the Dash ---
       WHETHER and HOW FAST belong to ctx.game.race; this runs the man.
       `mayorRun` exists so a cutscene or a test can drive the
       presentation without the rules layer having to be in a state
       where a race is legal. */
    get mayor() { return mayor || named.get(MAYOR_ID) || null; },
    get mayorState() { return mayorState; },
    mayorRun(o) { return startMayorRun(o || {}); },
    mayorStop() { stopMayorRun(null); },

    /** Everyone standing inside a doorway keep-clear, worst first.
        An empty `blocking` list is the fix, measured.

        `{before: true}` re-plans every standing spot on the SAME seeds
        with the penalty and the widened arc switched off — i.e. the
        code as it was — and reports what it would have produced. That
        is the A/B, and it is the only honest way to say the fix did
        anything. */
    doorAudit(opts = {}) {
      const rows = [];
      const spots = new Map();
      if (opts.before) {
        withOldRegime((oldSpot) => {
          for (const c of CLIENTS) {
            const locs = LOCATIONS.filter((l) => l.z === c.home);
            const rng = ctx.makeRng('npc.place.' + c.id);
            /* the same three draws planClient makes, in the same order */
            rng(); rng();
            const anchor = locs.length
              ? locs[Math.floor(rng() * locs.length) % locs.length] : null;
            if (!anchor) continue;
            spots.set(c.id, standingSpot(anchor, rng, oldSpot));
          }
        });
      }
      for (const h of all) {
        if (h.mayorDriven) continue;
        const p = spots.get(h.id) || h.root.position;
        let worst = 0, at = null;
        for (const d of DOORS) {
          const k = doorClearance(p.x, p.z, d.x, d.z, d.ax, d.az);
          if (k > worst) { worst = k; at = d; }
        }
        if (worst > (opts.min ?? 0.001)) {
          rows.push({
            who: h.id || 'stranger', kind: h.isClient ? 'client' : (h.agent ? 'wander' : 'res'),
            door: at.id, k: +worst.toFixed(3),
            metres: +Math.hypot(p.x - at.x, p.z - at.z).toFixed(2),
          });
        }
      }
      rows.sort((a, b) => b.k - a.k);
      /* AND THE OTHER DIRECTION: for every door, how far away the
         nearest human actually is. `blocking` proves nobody is in a
         corridor; this proves the corridors are not merely empty by
         luck — a door whose nearest person is 2.6 m away has an
         approach, and one whose nearest is 0.8 m does not, whatever the
         corridor test says about which side of it they are on. */
      const near = [];
      for (const d of DOORS) {
        let bd = Infinity, who = null;
        for (const h of all) {
          if (h.mayorDriven) continue;
          const p = spots.get(h.id) || h.root.position;
          const dd = Math.hypot(p.x - d.x, p.z - d.z);
          if (dd < bd) { bd = dd; who = h.id || 'stranger'; }
        }
        near.push({ door: d.id, metres: +bd.toFixed(2), who });
      }
      near.sort((a, b) => a.metres - b.metres);
      /* AND THE NAMED CLIENTS, AGAINST EVERY DOOR, AS RAW GEOMETRY.
         This section exists because its absence is what let the last
         round ship a green audit over a Barnaby standing 2.54 m off the
         apartment threshold: `blocking` only reports corridor
         membership, and `tightest` only reports the nearest body per
         door — neither says how far the PERMANENT residents of the
         frontage are from the entrance they are permanently beside.
         along/side are metres out along the door normal and metres
         across it, so a spot can be judged without re-deriving the
         corridor. Clients are the ones that matter: a wanderer in the
         way walks off, a client never does. */
      const clients = [];
      for (const h of all) {
        if (!h.isClient || h.mayorDriven) continue;
        const p = spots.get(h.id) || h.root.position;
        let bd = Infinity, at = null, along = 0, side = 0;
        for (const d of DOORS) {
          const ox = p.x - d.x, oz = p.z - d.z;
          const r = Math.hypot(ox, oz);
          if (r >= bd) continue;
          bd = r; at = d;
          along = ox * d.ax + oz * d.az;
          side = Math.abs(ox * d.az - oz * d.ax);
        }
        if (at) {
          clients.push({
            who: h.id, door: at.id, metres: +bd.toFixed(2),
            along: +along.toFixed(2), side: +side.toFixed(2),
          });
        }
      }
      clients.sort((a, b) => a.metres - b.metres);
      /* Does the replan still land where the checked-in figures say it
         did? Within 0.05 m, since they were rounded to centimetres. */
      let matches = null;
      if (opts.before) {
        matches = {};
        for (const k in BEFORE_FIXTURE) {
          const want = BEFORE_FIXTURE[k], got = clients.find((r) => r.who === k);
          matches[k] = got
            ? { want: want.metres, got: got.metres, door: got.door,
                ok: got.door === want.door && Math.abs(got.metres - want.metres) <= 0.05 }
            : { want: want.metres, got: null, ok: false };
        }
      }
      return {
        doors: DOORS.length, people: all.length,
        mode: opts.before ? 'before (pre-fix regime, re-planned)' : 'now',
        regime: opts.before ? REGIME.old : REGIME.now,
        blocking: rows.filter((r) => r.k > 0.25),
        grazing: rows.filter((r) => r.k <= 0.25).length,
        tightest: near.slice(0, 5),
        clientsNearestDoor: clients.slice(0, opts.clients ?? 6),
        expectBefore: BEFORE_FIXTURE,
        ...(matches ? { matches } : {}),
      };
    },

    /** Doorway dwell distribution for the wandering crowd, over time.
        `{reset:true}` starts a fresh window; `{evict:false}` restores
        the pre-round-3 loiter behaviour so the two can be compared on
        the same run. See crowd.js doorStats. */
    doorDwell(o) { return crowd.doorStats(o || {}); },
    /** Force the defect and time the recovery — see crowd.doorProbe. */
    doorProbe(o) { return crowd.doorProbe(o || {}); },
    doorProbeState() { return crowd.doorProbeState(); },

    /* --- Happy, the opening encounter ---
       The TRIGGER belongs to ctx.game (bus 'story', beat 'happy'). This
       is here so a cutscene, a test or the screenshot harness can run
       the beat directly; `happyStage` reports how far it has got. */
    happy(o) { return playHappy(o || {}); },
    get happyStage() { return happyState; },
    get happyLine() { return HAPPY_LINE; },

    /** Pose someone by hand: 'idle' | 'walk' | 'talk' | 'sit' | 'work' | 'wave' */
    setMode(id, mode) {
      const h = ensure(id);
      if (h) h.anim.setMode(mode);
      return h;
    },

    /** the whole population, meshed or merely planned */
    get count() { return all.length + pending.length; },
    get builtCount() { return all.length; },
    stats: humans.stats,
    /** boot profile: this module's phases, plus humans.js's own. */
    perf: P,

    update,
    dispose() {
      if (typeof window !== 'undefined') removeEventListener('keydown', onKey);
      happy = null;
      happyState = 'none';
      mayor = null;
      mayorState = 'none';
      bubbles.dispose();
      for (const h of all) h.dispose();
      all.length = 0;
      pending.length = 0;
      named.clear();
      humans.dispose();
      ctx.scene.remove(root);
    },
  };

  /* ------------------------------------------------------------
     Boot: everyone in place
     ------------------------------------------------------------ */
  /* WHAT BOOT ACTUALLY OWES THE PLAYER.

     This module was 8.4 s of a 13.9 s cold boot — the entire wait before
     anyone could play, spent meshing four hundred people of whom the
     nearest was 38 m away and most were on the far side of a 900 m
     island. What boot owes is the people you can see and the people you
     can talk to; everything else is scenery arriving.

     So boot PLANS the whole population — four hundred specs, positions,
     facings and poses, 134 ms — and MESHES only the named clients within
     BOOT_R of where Wally is standing. That is the set that populates
     the district you start in, and it is the set whose shared caches the
     streamer then inherits warm. The remainder is queued and streams in
     over the first second or so of play (see `stream`), nearest first.

     BOOT_R is a distance, not a timer, so the same build always meshes
     the same people at boot and the loading bar and every screenshot
     stay reproducible.

     PROGRESS + YIELD. ctx.boot.tick(f) reports a fraction and yields a
     frame so the bar can repaint and the tab stays responsive; the yield
     costs one frame, not one per character. It is still called across
     the client build and once per planning phase, so the bar advances
     smoothly over a stage that is now a fifth of what it was. */
  const BOOT_R = 150;

  const boot = ctx.boot;
  let _tp = performance.now();
  for (let i = 0; i < CLIENTS.length; i++) planClient(CLIENTS[i].id);

  /* mode variety across the standing clients so a district is not a
     row of statues in the same pose. Decided on the plan, in plan
     order, off the same stream as before — so it lands on the same
     people whether they are meshed now or in three seconds. */
  {
    const rng = ctx.makeRng('npc.modes');
    for (const r of pending) {
      if (r.kind !== 'client') continue;
      const v = rng();
      if (r.mode === 'work') continue;
      if (v < 0.14) r.mode = 'sit';
      else if (v < 0.24) r.mode = 'work';
    }
  }

  /* HOW MANY PEOPLE IS A TOWN. 153 spread over a 900 m island put ONE
     figure in the default 78 m framing of the market square and four at
     34 m: the square read as an evacuated diorama with Wally alone in a
     field, which is the one thing this module exists to prevent. A
     wanderer costs two draw calls when it is in frame, the 46-skeleton
     animation budget already caps the per-frame cost by distance, and
     everything past FAR is hidden outright — so the population is what
     it always was, 400-odd, and none of it is bought with boot time
     any more. */
  const baseCrowd = Math.round(clamp(40 + (q.particles ?? 1) * 140, 24, 180));
  planCrowd(baseCrowd);
  planResidents(q.particles >= 0.9 ? 12 : q.particles >= 0.5 ? 7 : 3);
  P.planned = pending.length;
  P.place = performance.now() - _tp;
  if (boot) await boot.tick(0.10);

  /* The clients close enough to be part of the opening shot. Sorted so
     the nearest is standing first if anything ever cuts this short. */
  {
    const anchor = ctx.wally?.position || new THREE.Vector3();
    const near = pending
      .filter((r) => r.kind === 'client' && Math.hypot(r.x - anchor.x, r.z - anchor.z) <= BOOT_R)
      .sort((a, b) => Math.hypot(a.x - anchor.x, a.z - anchor.z)
        - Math.hypot(b.x - anchor.x, b.z - anchor.z));
    for (let i = 0; i < near.length; i++) {
      takeRec(near[i]);
      if (boot) await boot.tick(0.10 + 0.85 * ((i + 1) / near.length));
    }
    P.clients = performance.now() - _tp;
  }
  if (boot) await boot.tick(0.98);

  /* ------------------------------------------------------------
     Debug hooks — the screenshot harness drives these
     ------------------------------------------------------------ */
  const dbg = (window.WALLY && window.WALLY.debug) || {};
  let camState = null;
  let lineupHumans = null;

  function takeCamera(px, py, pz, tx, ty, tz, fov) {
    camState = {
      pos: new THREE.Vector3(px, py, pz),
      look: new THREE.Vector3(tx, ty, tz),
      fov,
    };
    ctx.cam?.override?.(camState.pos, camState.look, fov);
    ctx.bus?.emit('cam:override', { owner: 'npc.debug' });
    applyCam();
    return { pos: camState.pos.toArray(), look: camState.look.toArray(), fov };
  }
  function applyCam() {
    if (!camState) return;
    const cam = ctx.camera;
    cam.position.copy(camState.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(camState.look);
    if (cam.isPerspectiveCamera) { cam.fov = camState.fov; cam.updateProjectionMatrix(); }
  }

  /** Stand in front of one named client and frame their head. */
  dbg.npcCam = (id, opts = {}) => {
    const h = ensure(id);
    if (!h) { console.warn(`[npc] no client "${id}"`); return null; }
    h.root.visible = true;
    h.active = true;
    h.asleep = false;
    if (opts.mode !== false) h.anim.setMode(opts.mode || 'idle');
    const p = h.root.position;
    const yaw = h.root.rotation.y;
    const d = opts.dist ?? 1.85;
    /* EYE LEVEL IS A BONE, NOT A FRACTION OF HEIGHT. A fraction is only
       right for a figure standing at rest, and a third of the named
       clients are sitting or leaning over a workbench — the first pass
       framed a seated Mabel from 0.6 m above her scalp. The head bone's
       world position already carries whatever the pose did to it. */
    h.byName.head.updateWorldMatrix(true, false);
    h.byName.head.getWorldPosition(_v2);
    const eye = _v2.y + 0.157 * (h.height / HUMAN_H);
    const aim = opts.full ? p.y + h.height * 0.52 : eye - 0.03;
    api.lookAt(id, new THREE.Vector3(
      p.x + Math.sin(yaw) * d, eye + 0.02, p.z + Math.cos(yaw) * d));
    return takeCamera(
      _v2.x + Math.sin(yaw) * d, eye + (opts.rise ?? 0.02), _v2.z + Math.cos(yaw) * d,
      _v2.x, aim, _v2.z,
      opts.fov ?? (opts.full ? 40 : 30),
    );
  };

  /**
   * A dozen generated humans in a row, facing camera, on flat-ish
   * ground — the review shot. Named clients first (they are the ones
   * that have to be recognisable), then generated strangers.
   */
  dbg.lineup = (opts = {}) => {
    const n = opts.n ?? 12;
    const ids = opts.ids || ['mabel', 'rico', 'juniper', 'bolt', 'tusk', 'penny',
      'thunder', 'maple', 'dot', 'ivy', 'grimm', 'vance'];
    const zone = ZONES[opts.zone || 'greenedge'];
    const cx = zone.world.x, cz = zone.world.z + 26;
    const pitch = opts.pitch ?? 0.95;
    const picked = [];
    for (let i = 0; i < n; i++) {
      let h = ensure(ids[i % ids.length]);
      if (!h || picked.includes(h)) h = all[(i * 7 + 3) % all.length];
      picked.push(h);
    }
    lineupHumans = picked;
    picked.forEach((h, i) => {
      const x = cx + (i - (picked.length - 1) / 2) * pitch;
      const z = cz;
      h.root.position.set(x, groundY(x, z), z);
      h.root.rotation.y = 0;
      h.baseYaw = 0;
      h.root.visible = true;
      h.active = true;
      h.asleep = false;
      if (h.agent) { h.agent.frozen = true; h.agent.speed = 0; h.agent.pos.copy(h.root.position); }
      if (opts.walk) {
        h.root.rotation.y = h.baseYaw = opts.yaw ?? 0.9;
        h.forceLoco = { speed: opts.speed ?? 1.35, turn: 0 };
        h.anim.setMode('walk');
      } else {
        h.forceLoco = null;
        h.anim.setMode(i === 3 ? 'wave' : i === 7 ? 'talk' : 'idle');
      }
      h.baseMode = h.anim.mode;
      h.anim.lookTarget = null;
      h.anim.lookW = 0;
      h.lookW = 0;
    });
    /* Frame them, do not survey them: the row is `span` wide and the
       camera has to sit far enough back to hold it at the given fov and
       no further, or the review shot is a landscape with ants in it. */
    const span = picked.length * pitch;
    const fov = opts.fov ?? 40;
    const aspect = (ctx.canvas?.width || 1600) / (ctx.canvas?.height || 800);
    const hfov = 2 * Math.atan(Math.tan(fov * Math.PI / 360) * aspect);
    const d = (span * 0.54) / Math.tan(hfov * 0.5) + 1.1;
    const y = ctx.world.heightAt(cx, cz + d);
    return takeCamera(cx, y + 1.02, cz + d, cx, ctx.world.heightAt(cx, cz) + 0.90, cz, fov);
  };

  /* ================================================================
     THE MAYOR — WALLY.debug.mayor()

     The verifier's entry point, and the shot that has to prove three
     separate claims at once: that he is a LIKENESS (white hair, white
     beard, ruddy face, navy button-up), that he is TALL (he is framed
     beside Wally and the street, not alone against the sky), and that
     he READS IN A RACE (the frame is the game's own over-the-shoulder
     camera at gameplay distance, not a portrait lens).

       WALLY.debug.mayor()          mid-dash, over Wally's shoulder
       WALLY.debug.mayor({t: 40})   forty seconds into the route
       WALLY.debug.mayorSolo()      the likeness, close
       WALLY.debug.mayorInfo()      where he is and how fast, measured
     ================================================================ */
  /* IS THERE A ROOF OVER THIS SPOT. The Dash runs down lanes that pass
     under and between 154 collision volumes, and the first three
     attempts at this screenshot put the lens inside a building —
     shots/x-mayor.png went plaster, plaster, then an interior floor
     with Wally standing in somebody's front room. A ray straight down
     from thirty metres against the physics statics is the only cheap
     query in the game that can tell open sky from a lobby. */
  const _rayO = new THREE.Vector3();
  const _rayD = new THREE.Vector3(0, -1, 0);
  function underRoof(x, z) {
    if (!ctx.phys?.raycast) return false;
    const g = ctx.world.heightAt(x, z);
    _rayO.set(x, g + 30, z);
    const hit = ctx.phys.raycast(_rayO, _rayD, 34);
    return !!hit && hit.point.y > g + 1.4;
  }

  dbg.mayor = (opts = {}) => {
    registerMayorPortrait();
    api.drain();
    const started = startMayorRun({
      route: ctx.game?.race?.route?.(),
      mayorSeconds: opts.seconds,
      mps: opts.mps,
    });
    if (!started) return 'no route';
    const h = mayor;
    /* drop him into the run, `t` seconds in, so he is mid-stride on a
       road rather than standing on the start line */
    mayorState = 'run';
    mayorT = opts.t ?? 26;
    mayorDist = clamp(mayorSpeed * mayorT, 0, mayorLen - 2);
    /* AND THEN MOVE HIM TO WHERE THE SHOT WORKS. Unless a `t` was asked
       for by hand, the three points this frame needs — him, Wally six
       metres back, and the lens six metres behind that — are scanned
       along the route for the first stretch where all three stand under
       open sky. It is a screenshot hook: it may take a hundred
       raycasts to find a frame that is actually of the thing it claims
       to be of. */
    if (opts.t == null) {
      const lens = (opts.gap ?? 6.5) + (opts.dist ?? 5.6);
      let bestD = -1, bestScore = -1e9;
      for (let d = 30; d < mayorLen - 20; d += 4) {
        mayorAt(d, _mv);
        if (underRoof(_mv.x, _mv.z)) continue;
        mayorAt(d - (opts.gap ?? 6.5), _v2);
        if (underRoof(_v2.x, _v2.z)) continue;
        mayorAt(d - lens, _door);
        if (underRoof(_door.x, _door.z)) continue;
        /* AND NOT IN THE MIDDLE OF A SCRUM. The first open stretch on
           the route is a forecourt with a dozen residents on it, and
           they stand between the lens and the subject: the shot came
           back as a wall of shoulders with a small running man behind
           it. Penalising near-field bodies picks an open stretch of the
           same road instead. */
        let crowdNear = 0;
        for (const h of all) {
          if (h.asleep || h.mayorDriven) continue;
          if (h.root.position.distanceTo(_door) < 7) crowdNear++;
        }
        const score = -crowdNear * 3 - d * 0.004;
        if (score > bestScore) { bestScore = score; bestD = d; }
      }
      if (bestD > 0) mayorDist = bestD;
    }
    mayorAt(mayorDist, _mv);
    h.root.position.copy(_mv);
    /* face along the route */
    mayorAt(Math.min(mayorDist + 3, mayorLen), _v2);
    h.root.rotation.y = Math.atan2(_v2.x - _mv.x, _v2.z - _mv.z);
    h.anim.setMode(MAYOR.RUN_ANIM);
    h.anim.w.run = 1; h.anim.w.walk = 1; h.anim.speed = mayorSpeed;
    /* wind the cycle to a moment where one leg is up: the pose that
       says "running" in a still frame */
    h.anim.walkPhase = 1.15;
    h.anim.update(1 / 60, 0, { speed: mayorSpeed, turn: 0 });

    /* WALLY IS IN THIS SHOT ON PURPOSE. "Noticeably taller than the
       other NPCs" is a claim about a comparison, and a comparison needs
       both terms in the frame. He is put a few metres back down the
       Mayor's own route, which is also where a player who is losing
       actually is. */
    const back = opts.gap ?? 6.5;
    mayorAt(Math.max(0, mayorDist - back), _v2);
    ctx.wally?.setBike?.(false, { instant: true });
    ctx.wally?.setPosition?.(_v2.x, _v2.y, _v2.z);
    ctx.wally?.setYaw?.(Math.atan2(_mv.x - _v2.x, _mv.z - _v2.z));
    ctx.wally?.look?.(h.byName.head, 1);

    mayorFrozen = opts.frozen !== false;
    /* a long ttl for the same reason: the shutter opens seconds after
       this returns, and a 3.8 s bubble is gone by then */
    if (opts.say !== false) {
      const line = MAYOR_LINES.behind[0];
      bubbles.show(h, line, { key: 'mayor', ttl: 120, tint: '#c98a3a', force: true });
    }

    /* THE CAMERA SWINGS OFF THE LINE. Dead behind, the lens, Wally and
       the Mayor are collinear BY CONSTRUCTION — all three stand on the
       same road — and a 1.6 m elephant five metres from the camera
       hides a 2.08 m man twelve metres from it almost exactly. That was
       the fourth failed attempt at this shot: a perfect street, and the
       subject behind Wally's ears. Swung a quarter-radian to whichever
       side has open sky over it, both figures are in frame with the
       road running between them, which is the composition a chase
       actually has. `underRoof` is what keeps the swing out of the
       building it would otherwise swing into. */
    const d0 = opts.dist ?? 5.6;
    const base = Math.atan2(_mv.x - _v2.x, _mv.z - _v2.z);
    let ex = _v2.x - Math.sin(base) * d0, ez = _v2.z - Math.cos(base) * d0;
    for (const swing of [0.50, -0.50, 0.78, -0.78, 0]) {
      const a2 = base + swing;
      const cx2 = _v2.x - Math.sin(a2) * d0, cz2 = _v2.z - Math.cos(a2) * d0;
      if (!underRoof(cx2, cz2)) { ex = cx2; ez = cz2; break; }
    }
    return {
      ...started,
      ...takeCamera(ex, groundY(ex, ez) + 2.55, ez,
        (_mv.x + _v2.x) * 0.5, _mv.y + 1.30, (_mv.z + _v2.z) * 0.5, opts.fov ?? 46),
      mayor: _mv.toArray().map((v) => +v.toFixed(1)),
      height: +h.height.toFixed(2),
    };
  };

  /** HIS LIKENESS ON ITS OWN — the hair, the beard, the ruddy face, the
      navy button-up. The race shot proves he READS; it cannot prove he
      is a likeness, because at twelve metres his head is ninety pixels.
      Every judgement about the transcription — thick white hair swept
      back, full white beard, pink complexion, dark navy shirt — was
      made against this hook.

      HE IS MOVED TO OPEN GROUND FIRST, and that is not vanity: he
      stands on a Main Street forecourt hemmed in by an awning, a
      lamp-post and a fruit stall, and a 2.3 m portrait lens put inside
      any of them photographs the inside of a crate. `lineup` solves the
      same problem the same way. */
  dbg.mayorSolo = (y = 1.62, dist = 2.3, fov = 34) => {
    const h = ensureMayor();
    if (!h) return 'no mayor';
    api.drain();
    h.exempt = true;
    if (h.agent) { h.agent.frozen = true; h.agent.speed = 0; }
    const zone = ZONES.greenedge;
    const px = zone.world.x, pz = zone.world.z + 26;
    h.root.position.set(px, groundY(px, pz), pz);
    h.root.rotation.y = h.baseYaw = 0;
    h.root.visible = true; h.active = true; h.asleep = false;
    h.anim.setMode('idle');
    h.anim.lookTarget = null; h.anim.lookW = 0; h.lookW = 0;
    h.anim.update(1 / 60, 0, _still);
    const p = h.root.position;
    const a = h.root.rotation.y + 0.34;
    return {
      ...takeCamera(
        p.x + Math.sin(a) * dist, p.y + y + 0.06, p.z + Math.cos(a) * dist,
        p.x, p.y + y, p.z, fov),
      height: +h.height.toFixed(2),
    };
  };

  dbg.mayorInfo = () => ({
    state: mayorState,
    built: !!mayor,
    height: mayor ? +mayor.height.toFixed(2) : null,
    medianHeight: (() => {
      const hs = all.filter((x) => !x.isClient).map((x) => x.height).sort((a, b) => a - b);
      return hs.length ? +hs[hs.length >> 1].toFixed(2) : null;
    })(),
    routeMetres: +mayorLen.toFixed(1),
    mps: +mayorSpeed.toFixed(2),
    dist: +mayorDist.toFixed(1),
    pos: mayor ? mayor.root.position.toArray().map((v) => +v.toFixed(1)) : null,
    spec: mayor ? {
      hair: mayor.spec.hair, hairCol: mayor.spec.hairCol, beard: mayor.spec.beard,
      hat: mayor.spec.hat, shirt: '#' + (mayor.spec.shirtCol || 0).toString(16),
    } : null,
    race: ctx.game?.race?.status?.() ?? null,
  });

  /* ================================================================
     THE BUBBLES — WALLY.debug.bubbles()

     Forces three lines out over three different people immediately,
     rather than waiting out the four-to-nine second spacing, and
     returns who said what so the verifier can check the text against
     the picture. `WALLY.debug.bubbleHint()` fires the scooter line
     through the same path the rules layer uses.
     ================================================================ */
  /* ================================================================
     WHAT THE STREET CAN CURRENTLY SAY — WALLY.debug.bubbleScene()

     The scene as the picker sees it right now, plus every group that
     scene opens and how big each one is. This is the hook to reach for
     when a line reads wrong in place: it says whether the world is
     publishing what you assumed, before you go looking at the words.
     `zoneAt` is sampled at the camera, which is where the player is.
     ================================================================ */
  /** THE RUNTIME REVERT for the balloon's reach — see `gawkReach`.
      Returns the mode ACTUALLY in force and the radius the last frame
      actually produced, never the one asked for. */
  dbg.gawkReach = (mode) => {
    if (mode === 'flat' || mode === 'lens') gawkReach = mode;
    return { mode: gawkReach, reach: +noticeR.toFixed(1) };
  };

  /** THE RUNTIME REVERT for the draw cull (contracts.js rule 1).
      'off' is the rule that shipped before this round to the digit —
      FAR = 200 for the skinned crowd, thinning from 110, no instanced
      band and no sky crowd drawn — and 'on' is the one that ships now.
      Both branches on ONE page load, which is what makes a before-and
      -after a measurement instead of a citation. Returns what the last
      frame ACTUALLY produced, never what was asked for. */
  dbg.skyCrowd = (mode) => {
    if (mode === 'on' || mode === 'off') skyMode = mode;
    return { mode: skyMode, drawn: skyDrawn, candidates: skyCand,
      noticing: skyNotice, built: !!sky, reach: +noticeR.toFixed(1) };
  };

  dbg.bubbleScene = () => {
    ctx.camera.getWorldPosition(_v);
    const at = ctx.wally?.position || _v;
    const s = sceneFor({ root: { position: at } });
    return {
      scene: { ...s },
      groups: linePicker.groupsFor(s).map((g) => ({ g: g.name, w: g.w, n: g.lines.length })),
      used: linePicker.stats(),
      gawk: { live: gawkLive, w: +gawk.toFixed(3), looking: gawkers, burst: balloonBurst,
        /* THE THREE READS, IN THE ORDER THEY SURVIVE DISTANCE.
           `pointing` and `stopped` are the ones that carry from the
           basket; `looking` is the one that carries from the pavement.
           `reach` is the number that was silently 62 m for every
           altitude before this and is why the other three were zero. */
        pointing: pointers, stopped: stoppers, reach: +noticeR.toFixed(1),
        /* AND THE ONE THE OTHER FOUR DEPEND ON. `sky` is how many of
           the people in the picture are drawn at all past 150 m; it
           was structurally zero before this round, and a `looking`
           count taken while it is zero is a count of people nobody
           can see. `skyMode` says which branch produced it. */
        sky: skyDrawn, skyCand, skyNotice, skyMode,
        t: +gawkT.toFixed(2), flying: !!ctx.wally?.flying,
        all: all.length, active: all.filter((h) => h.active).length,
        biased: all.filter((h) => h.gawkBias !== undefined).length,
        on: all.filter((h) => h.gawkOn).length,
        /* the craning, in degrees off level, most-tilted first. Negative
           is UP. This is the number the ±0.45 rad clamp used to cap at
           26° and now stops at 40° of head plus the chest's share. */
        craneDeg: all.filter((h) => h.gawkOn && h.anim)
          .map((h) => +(-h.anim.headPitch * 180 / Math.PI).toFixed(1))
          .sort((a, b) => b - a).slice(0, 5) },
    };
  };

  /* ================================================================
     DOES IT REPEAT? — WALLY.debug.bubbleAudit({picks, ...scene})

     Runs the real picker, on a fresh stream, over a FIXED scene, and
     reports the smallest number of picks between two occurrences of
     the same line. This is the assertion the old picker could not have
     passed: uniform choice over one flat pool of forty-four repeats
     inside seven picks about half the time, which at one line every
     four to nine seconds is the same sentence twice in a minute.

     `minGap` is the number that matters. Anything under about twenty
     in a normal street scene means a player on a walk hears a repeat.
     ================================================================ */
  dbg.bubbleAudit = (o = {}) => {
    const picks = o.picks ?? 400;
    const scene = {
      zone: o.zone ?? null, hour: o.hour ?? 12,
      rainfall: o.rainfall ?? 0, storminess: o.storminess ?? 0,
      pct: o.pct ?? 0, rep: o.rep ?? 0, seeing: o.seeing ?? null,
    };
    const p = createLinePicker(ctx.makeRng(o.seed || 'npc.bubbles.audit'));
    const seen = new Map(), distinct = new Set(), byGroup = {};
    let minGap = Infinity, worst = null;
    for (let i = 0; i < picks; i++) {
      const r = p.pick(scene, { detail: true });
      byGroup[r.group] = (byGroup[r.group] || 0) + 1;
      distinct.add(r.line);
      if (seen.has(r.line)) {
        const g = i - seen.get(r.line);
        if (g < minGap) { minGap = g; worst = r.line; }
      }
      seen.set(r.line, i);
    }
    return {
      scene, picks, distinct: distinct.size, ring: p.ring, desperate: p.desperate,
      minGap: minGap === Infinity ? null : minGap, worst, byGroup,
    };
  };

  /** Every line in the file, laid out with the real font and the real
      wrap. `rows3` and `elided` must both be empty. */
  dbg.bubbleFit = () => bubbles.measure(ALL_LINES);

  dbg.bubbles = (n = 3) => {
    api.drain();
    ctx.camera.updateMatrixWorld();
    ctx.camera.getWorldPosition(_v);
    const said = [];
    for (let i = 0; i < n; i++) {
      const h = bubbleCandidate(_v, true);
      if (!h) break;
      const line = pickLine(h);
      if (bubbles.show(h, line, { ttl: 240 })) {
        h.bubbleAt = elapsed;
        h.anim.setMode('talk');
        h.sayT = 1e6;
        /* HOLD THEM STILL FOR THE SHUTTER. shot.mjs runs its --eval and
           then waits out the settle, and a walker covers eleven metres
           in that time — the first bubble shot photographed three
           speech balloons pointing off the edge of the frame. */
        if (h.agent) { h.agent.frozen = true; h.agent.speed = 0; }
        said.push({ who: h.id || h.spec?.id || 'stranger', line });
      }
    }
    bubbles.update(0.30, elapsed);
    return { said, live: bubbles.live };
  };
  /** A STREET-LEVEL CAMERA WITH THE CITY TALKING IN IT. The ambient
      lines are a gameplay-distance feature by design — nothing speaks
      past thirty metres, and a debug fly-to sits sixty metres up, so a
      vista shot of a district correctly shows no bubbles at all. This
      is the frame the feature actually lives in. */
  dbg.bubbleCam = (locId = 'marketsq', opts = {}) => {
    api.drain();
    /* WALK THE ROADS AND STOP WHERE THE PEOPLE ARE.

       Three earlier versions of this hook aimed at a location, then at
       the crowd's own centroid, and both put the lens indoors — the
       centroid of the people at Market Hall is inside the Market Hall,
       and the ring around it is inside the awnings. The roads are the
       one surface in this city that is guaranteed to be outdoors and
       guaranteed to have pedestrians on it, which is the whole subject
       of the feature: lines overheard from people walking past. So the
       Mayor's own route — already stitched out of the road graph — is
       walked in four-metre steps, and the step with the most people
       ahead of the lens and open sky over it wins. */
    const built = buildMayorPath(ctx.game?.race?.route?.());
    if (!built.pts.length) return 'no roads';
    mayorPath = built.pts; mayorLen = built.len;
    /* THE ARGUMENT USED TO BE A LIE. `locId` was named, defaulted and
       documented, and then never read — every call walked the whole
       route and stopped at the same busiest corner, so
       bubbleCam('waterfront') photographed Main Street. That did not
       matter while every person in the city drew from one flat list.
       It matters now: a shot of the docks has to BE at the docks or it
       is not a shot of the feature. Takes a zone id or a location id,
       and holds the walk inside that district. */
    let wantZone = null;
    if (locId) {
      if (ctx.world?.zones?.[locId]) wantZone = locId;
      else {
        const locs = ctx.world?.locations;
        const arr = Array.isArray(locs) ? locs : Object.values(locs || {});
        wantZone = arr.find((x) => x && x.id === locId)?.z ?? null;
      }
    }
    const look = new THREE.Vector3(), eye = new THREE.Vector3();
    let bestD = -1, bestN = -1;
    for (let d = 12; d < mayorLen - 12; d += 4) {
      mayorAt(d, eye);
      mayorAt(d + 10, look);
      if (wantZone) {
        let z = null;
        try { z = ctx.world.zoneAt(eye.x, eye.z)?.id ?? null; } catch (e) { z = null; }
        if (z !== wantZone) continue;
      }
      const fx = look.x - eye.x, fz = look.z - eye.z;
      const fl = Math.hypot(fx, fz) || 1;
      /* THE WHOLE SHOT HAS TO BE OUTDOORS, not just the lens. Checking
         the eye alone picked a spot two metres clear of Dispatch's
         first-floor overhang and photographed the underside of it. The
         eye, the ground Wally stands on, the point being looked at, and
         a stride to either side of the lens all have to have sky over
         them — five taps, once, in a debug hook. */
      if (underRoof(eye.x, eye.z)) continue;
      if (underRoof(eye.x + fx * 0.44 / fl * 10, eye.z + fz * 0.44 / fl * 10)) continue;
      if (underRoof(look.x, look.z)) continue;
      if (underRoof(eye.x + fz / fl * 2.2, eye.z - fx / fl * 2.2)) continue;
      if (underRoof(eye.x - fz / fl * 2.2, eye.z + fx / fl * 2.2)) continue;
      let n = 0;
      for (const h of all) {
        if (h.asleep || h.isClient) continue;
        const dx = h.root.position.x - eye.x, dz = h.root.position.z - eye.z;
        const dd = Math.hypot(dx, dz);
        if (dd < 6 || dd > 20) continue;
        if ((dx * fx + dz * fz) / (fl * dd) < 0.55) continue;
        n++;
      }
      if (n > bestN) { bestN = n; bestD = d; }
    }
    if (bestD < 0) return wantZone ? 'no open road in ' + wantZone : 'nowhere open';
    mayorAt(bestD, eye);
    mayorAt(bestD + 10, look);
    const a0 = Math.atan2(look.x - eye.x, look.z - eye.z);
    /* Wally in the frame, walking the same street — this is a shot of
       the city he is standing in, not a survey of it */
    const wx = eye.x + Math.sin(a0) * 4.4, wz = eye.z + Math.cos(a0) * 4.4;
    /* `keepWally` leaves him exactly where he is and only re-takes the
       camera. It is what makes a BALLOON shot possible at all: the
       flight camera claims the lens the moment he lifts off, so the
       street view has to be taken back after he is already up — and
       moving him at that point would drop the basket on the road. The
       spot search above is deterministic, so the second call frames the
       identical street. */
    if (!opts.keepWally) {
      ctx.wally?.setBike?.(false, { instant: true });
      ctx.wally?.setPosition?.(wx, groundY(wx, wz), wz);
      ctx.wally?.setYaw?.(a0);
    }
    takeCamera(eye.x, groundY(eye.x, eye.z) + 2.25, eye.z,
      look.x, groundY(look.x, look.z) + 1.45, look.z, opts.fov ?? 50);
    ctx.camera.updateMatrixWorld();
    ctx.camera.matrixWorldInverse.copy(ctx.camera.matrixWorld).invert();
    /* WARM THE STREAM. The picker is seeded, so every fresh page load
       overhears the city in the same order and the first two lines of
       a shot are always the same two lines — which is exactly what
       reproducible screenshots are for, and exactly wrong when what
       you want to photograph is the fifth thing the docks say. `warm`
       burns N picks against the live scene and throws them away. */
    for (let i = 0; i < (opts.warm | 0); i++) linePicker.pick(sceneFor(all[0]));
    return { zone: wantZone, ahead: bestN, ...dbg.bubbles(opts.n ?? 3) };
  };

  dbg.bubbleHint = () => {
    const r = ctx.game?.race?.hint?.();
    if (!r) sayHint(RACE.hints[0].text);      // the rules layer said no
    return { fromRules: !!r, text: r ? r.text : RACE.hints[0].text };
  };

  /* ================================================================
     THE DOORWAYS — WALLY.debug.doorAudit()

     The fix for "Barnaby and other NPCs are too close to the entrances"
     is a score, so it is measurable: this walks every person in the
     game against every door and reports anybody inside a keep-clear,
     worst first. A green run is an empty `blocking` list.
     ================================================================ */
  dbg.doorAudit = (o) => api.doorAudit(o || {});
  /* The other half of the same question: doorAudit is a snapshot of the
     standers, doorDwell is the crowd measured over time — how long a
     wanderer stays in a doorway, which a snapshot cannot see. */
  dbg.doorDwell = (o) => crowd.doorStats(o || {});
  dbg.doorProbe = (o) => crowd.doorProbe(o || {});
  dbg.doorProbeState = () => crowd.doorProbeState();

  const LOC = (id) => LOCATIONS.find((x) => x.id === id)
    || LOCATIONS.filter((x) => x.z === id)[0] || LOCATIONS[0];

  /** Stand in the approach corridor and look at the door. This is the
      shot the complaint is about: if anybody is in the way of an
      entrance, this is the frame they are in the way of. */
  dbg.doorCam = (locId, opts = {}) => {
    api.drain();
    const d = DOORS.find((x) => x.id === locId) || DOORS[0];
    if (!d) return 'no doors';
    const back = opts.dist ?? 9.5;
    const ex = d.x + d.ax * back, ez = d.z + d.az * back;
    const l = LOCATIONS.find((x) => x.id === d.id);
    ctx.wally?.setBike?.(false, { instant: true });
    /* Wally stands where the game would put him: on the door point, the
       far end of the corridor this hook exists to photograph. */
    const wx = d.x + d.ax * 2.2, wz = d.z + d.az * 2.2;
    ctx.wally?.setPosition?.(wx, groundY(wx, wz), wz);
    ctx.wally?.setYaw?.(Math.atan2(-d.ax, -d.az));
    return {
      door: d.id,
      ...takeCamera(ex, groundY(ex, ez) + (opts.up ?? 3.0), ez,
        d.x, groundY(d.x, d.z) + 1.5, d.z, opts.fov ?? 50),
      people: api.at(d.id).length,
      audit: api.doorAudit().tightest.filter((r) => r.door === d.id),
      loc: l ? l.n : d.id,
    };
  };

  dbg.npcRelease = () => {
    /* whatever a debug hook froze, the game gets back */
    mayorFrozen = false;
    if (mayor) { mayor.exempt = false; if (mayor.agent) mayor.agent.frozen = false; }
    for (const h of all) if (h.agent && h.bubbleAt != null) h.agent.frozen = false;
    bubbles.clear();
    camState = null;
    ctx.cam?.releaseOverride?.();
    ctx.bus?.emit('cam:release', { owner: 'npc.debug' });
    if (lineupHumans) {
      for (const h of lineupHumans) {
        if (h.home) h.root.position.copy(h.home);
        if (h.agent) { h.agent.frozen = false; h.agent.pause = 0; }
      }
      lineupHumans = null;
    }
  };

  /** Street level: stand Wally at a location and frame the district
      from over his shoulder — the view the game is actually played in. */
  dbg.npcStreet = (locId, opts = {}) => {
    const l = LOCATIONS.find((x) => x.id === locId) || LOCATIONS[0];
    const rng = ctx.makeRng('npc.street.' + locId);
    const p = standingSpot(l, rng, { want: 1.0, near: 3.0, far: 7.0 });
    ctx.wally?.setPosition?.(p.x, p.y, p.z);
    const a = (opts.turn ?? 0) + Math.atan2(l.world.x - p.x, l.world.z - p.z);
    ctx.wally?.setYaw?.(a);
    const d = opts.dist ?? 4.6;
    const ex = p.x - Math.sin(a) * d, ez = p.z - Math.cos(a) * d;
    return takeCamera(ex, ctx.world.heightAt(ex, ez) + 2.0, ez,
      p.x + Math.sin(a) * 6, p.y + 1.1, p.z + Math.cos(a) * 6, opts.fov ?? 52);
  };

  /** Frame whichever wanderer is currently moving fastest — the only
      honest way to look at the walk cycle. */
  dbg.npcWalkCam = (opts = {}) => {
    let best = null, bs = 0;
    for (const a of crowd.agents) {
      if (a.human.asleep) continue;
      if (a.speed > bs) { bs = a.speed; best = a; }
    }
    if (!best) return null;
    const h = best.human;
    h.asleep = false; h.active = true; h.root.visible = true;
    const p = h.root.position;
    const side = (opts.side ?? 0.9) + h.root.rotation.y;
    const d = opts.dist ?? 3.4;
    const ex = p.x + Math.sin(side) * d, ez = p.z + Math.cos(side) * d;
    return takeCamera(ex, p.y + 1.35, ez, p.x, p.y + 0.85, p.z, opts.fov ?? 36);
  };

  /** Walk Wally up to a named client — the approach, the prompt, the
      turn of the head. This is the interaction, in one call. */
  dbg.npcApproach = (id, opts = {}) => {
    const h = ensure(id);
    if (!h) { console.warn(`[npc] no client "${id}"`); return null; }
    const yaw = h.root.rotation.y;
    const d = opts.stand ?? 2.5;
    const wx = h.root.position.x + Math.sin(yaw) * d;
    const wz = h.root.position.z + Math.cos(yaw) * d;
    ctx.wally?.setPosition?.(wx, ctx.world.heightAt(wx, wz), wz);
    ctx.wally?.setYaw?.(yaw + Math.PI);
    const cd = opts.dist ?? 3.6;
    const cx = wx + Math.sin(yaw) * cd, cz = wz + Math.cos(yaw) * cd;
    return takeCamera(cx, ctx.world.heightAt(cx, cz) + 1.85, cz,
      h.root.position.x, h.root.position.y + 1.15, h.root.position.z,
      opts.fov ?? 44);
  };

  dbg.npcCount = () => {
    let vis = 0, tris = 0, cast = 0;
    for (const h of all) {
      if (!h.root.visible) continue;
      vis++;
      const t = h.body.geometry.index.count / 3 + h.head.geometry.index.count / 3;
      tris += t;
      if (h.body.castShadow) cast += t;
    }
    return {
      total: all.length + pending.length, built: all.length, queued: pending.length,
      named: named.size, crowd: crowd.agents.length,
      live: all.filter((h) => h.active).length,
      visible: vis, visibleTris: tris, shadowCasterTris: cast,
      bodyTris: humans.stats.bodyTriangles,
      bodyTrisCoarse: humans.stats.bodyTrianglesCoarse,
      buildMs: humans.stats.buildMs,
    };
  };
  /** Finish the population immediately — for screenshots and tests. */
  dbg.npcDrain = () => api.drain();
  dbg.npcSay = (id, text) => api.say(id, text || 'Morning, Wally.');
  dbg.npcMode = (id, m) => api.setMode(id, m);

  /* ================================================================
     HAPPY — WALLY.debug.happy(opts)

     The verifier's entry point, and the one shot that has to prove the
     encounter: Happy standing at conversational distance, facing Wally,
     mid-line, with Wally's head turned back at him. It places him at
     the stop point rather than making the harness wait eleven metres
     for him to walk (`happy(true)` runs the real approach instead), and
     it takes a TWO-SHOT camera — side-on, eye level, both figures in
     frame with the gap between them visible, which is what makes it
     read as a conversation and not as two people who happen to be near
     each other.

       WALLY.debug.happy()           stage it and frame it
       WALLY.debug.happy(true)       play it for real, from 11 m out
       WALLY.debug.happyInfo()       where the beat is, measured
     ================================================================ */
  dbg.happy = (walk = false, opts = {}) => {
    const w = ctx.wally;
    if (!w) return 'no wally';
    /* The opening beat is meant to happen where the player starts, on
       the ground, not wherever a previous debug hook parked him. */
    w.setBike?.(false, { instant: true });
    const h = api.happy({ instant: !walk });
    if (!h) return 'no happy';
    api.drain();

    const wp = w.position;
    const hp = h.root.position;
    /* Wally faces him; without this the two-shot is a conversation with
       the back of an elephant. */
    w.face?.(hp);
    w.look?.(h.byName.head, 1);

    /* THE TWO-SHOT. Perpendicular to the line between them, so the gap
       is visible, at 1.60 m — a shade over both their eye lines — and
       pulled back far enough to hold a 1.68 m human and a 1.60 m
       elephant plus air. Aimed at the midpoint at 1.16 m, which lands
       both figures in the UPPER two thirds: the dialogue card owns the
       bottom of the frame, and a two-shot that the card cuts in half is
       not a two-shot. */
    const mx = (wp.x + hp.x) * 0.5, mz = (wp.z + hp.z) * 0.5;
    /* NOT dead perpendicular. At exactly 90 degrees the two stand at
       opposite edges of the frame with two metres of empty grass down
       the middle, which reads as two strangers ignoring each other.
       Swung 26 degrees round, their silhouettes just overlap and the
       composition closes.

       AND IT SWINGS ROUND TOWARD WALLY, NOT TOWARD HAPPY. The sign of
       that was wrong and it cost the shot: swung the other way the lens
       sits behind Happy's shoulder and photographs the back of his head
       for the entire beat — see shots/c0-happy.png, where the only
       thing visible of the man saying the line is a blond crown. From
       this side it is the over-the-shoulder every film has used for a
       hundred years: the player's own character with his back to us,
       the person who is talking facing the camera. Which is also the
       only framing in which any of his likeness is on screen. */
    const a = Math.atan2(hp.x - wp.x, hp.z - wp.z) + Math.PI / 2 + 0.45;
    const d = opts.dist ?? 4.05;
    takeCamera(
      mx + Math.sin(a) * d, wp.y + 1.52, mz + Math.cos(a) * d,
      mx, wp.y + 1.12, mz,
      opts.fov ?? 36,
    );
    return {
      stage: api.happyStage,
      line: api.happyLine,
      gap: +wp.distanceTo(hp).toFixed(2),
      happy: hp.toArray().map((v) => +v.toFixed(2)),
      wally: wp.toArray().map((v) => +v.toFixed(2)),
    };
  };
  /* ================================================================
     HIS LIKENESS ON ITS OWN — WALLY.debug.happySolo(y, dist)

     The two-shot proves the ENCOUNTER. It cannot prove the LIKENESS:
     Happy is 1.68 m tall in a frame that also has to hold a 1.60 m
     elephant and a dialogue card, so his head is 90 px and his tee is
     40, and at that size a jacket lapel and a printed elephant are two
     smudges. Every judgement about whether he looks like the man in
     ref/happy-ref.webp — the parting, the sweep, the open blazer, the
     V of the tee, the print — was made against this hook instead, and
     it is left here so the next person can check the same things.

       WALLY.debug.happySolo()        head to knee, front on
       WALLY.debug.happySolo(1.45, 0.9)   the face, close
       WALLY.debug.happySolo(1.10, 1.4)   the tee print
     ================================================================ */
  dbg.happySolo = (y = 1.16, dist = 2.1, fov = 34) => {
    const h = happy || api.happy({ instant: true });
    if (!h) return 'no happy';
    api.drain();
    /* Out of `talk`: his gesture arm crosses the chest and hides the
       one panel this hook exists to look at. */
    h.anim.setMode('idle');
    h.sayT = 0;
    h.baseMode = 'idle';
    const p = h.root.position;
    const yaw = h.root.rotation.y;
    /* stand where he is looking, a few degrees off axis so the parting
       and the jaw both read */
    const a = yaw + 0.30;
    return takeCamera(
      p.x + Math.sin(a) * dist, p.y + y + 0.10, p.z + Math.cos(a) * dist,
      p.x, p.y + y, p.z, fov,
    );
  };

  dbg.happyInfo = () => {
    const w = ctx.wally;
    return {
      stage: api.happyStage,
      spawned: !!happy,
      fade: +happyFade.toFixed(3),
      t: +happyT.toFixed(2),
      pos: happy ? happy.root.position.toArray().map((v) => +v.toFixed(2)) : null,
      yaw: happy ? +happy.root.rotation.y.toFixed(3) : null,
      mode: happy ? happy.anim.mode : null,
      gap: happy && w ? +happy.root.position.distanceTo(w.position).toFixed(2) : null,
      flag: !!ctx.game?.story?.beats?.().happy,
      dialogueOpen: !!ctx.ui?.dialogueOpen,
    };
  };
  if (window.WALLY) window.WALLY.debug = dbg;

  /* camera.js is the authority while an override is live (it writes
     exactly what it was handed and touches nothing else), so this is
     only the belt to its braces for the frame the override is set. */
  api.lateUpdate = () => { if (camState && !ctx.cam) applyCam(); };

  P.total = performance.now() - t0;
  P.h = humans.perf;
  console.log(`[npc] ${all.length + pending.length} people planned `
    + `(${all.length} built at boot, ${pending.length} streaming), `
    + `${humans.stats.bones} bones, ${P.total.toFixed(0)} ms`);
  if (ctx.flags?.debug || new URLSearchParams(location.search).has('npcperf')) {
    const r = (x) => +x.toFixed(0);
    console.log('[npc.perf]', JSON.stringify({
      total: r(P.total), planned: P.planned, builtAtBoot: all.length,
      planning: r(P.place), clients: r(P.clients),
      perChar: { build: r(P.build), wrapAnim: r(P.wrap) },
      inBuild: {
        n: P.h.n, skeleton: r(P.h.skel), bodyColors: r(P.h.bodyCol),
        headMerge: r(P.h.head), meshBind: r(P.h.mesh), lazyCacheMiss: r(P.h.cacheMiss),
      },
      misses: P.h.m,
      caches: { bodiesFine: r(P.h.bodiesFine), bodiesCoarse: r(P.h.bodiesCoarse), skinWeights: r(P.h.skin) },
    }));
  }

  return api;
}

export default init;
