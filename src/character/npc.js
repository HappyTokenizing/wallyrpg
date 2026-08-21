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
import { CLIENTS, CLIENT_BY_ID, LOCATIONS, ZONES } from '../game/data.js';
import { createHumans, randomSpec, H as HUMAN_H } from './humans.js';
import { HumanAnim, createCrowd } from './crowd.js';

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
const THIN0 = 110;            // distance thinning starts
const THIN_MAX = 0.55;        // fraction dropped by FAR
const TALK_RANGE = 3.4;       // the approach prompt

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

  const _door = new THREE.Vector3();
  function standingSpot(loc, rng, opts = {}) {
    const _tp = performance.now();
    const want = opts.want ?? 2.1;
    const cx = loc.world.x, cz = loc.world.z;
    let ax = cx, az = cz, outA = rng() * Math.PI * 2, arc = Math.PI;
    const d = ctx.city?.doorPosition?.(loc.id, _door);
    if (d && Number.isFinite(d.x)) {
      ax = d.x; az = d.z;
      const ox = ax - cx, oz = az - cz;
      if (Math.hypot(ox, oz) > 0.4) { outA = Math.atan2(ox, oz); arc = 1.25; }
    }
    const near = opts.near ?? 1.7;
    const far = opts.far ?? Math.max(near + 1.4, Math.min(7, (loc.radius || 9) * 0.7));
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
      const score = -Math.abs(dRoad - want) * roadW - slope * 7 + outward * 0.22;
      if (score > bestScore) { bestScore = score; best = { x, y, z, a }; }
    }
    if (!best) best = { x: ax, y: ctx.world.heightAt(ax, az), z: az, a: outA };
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
    let p = pos, homeLoc = null, yaw;
    if (!p) {
      /* their home is a district; stand them by a location inside it */
      const locs = LOCATIONS.filter((l) => l.z === c.home);
      const z = ZONES[c.home];
      const anchor = locs.length
        ? locs[Math.floor(rng() * locs.length) % locs.length]
        : null;
      const ref = anchor || { id: null, world: { x: z ? z.world.x : 0, z: z ? z.world.z : 0 }, radius: 16 };
      p = standingSpot(ref, rng, { near: 2.0, far: 6.0 });
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
  const crowd = createCrowd(ctx, { groundY, roadLift });
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
          : standingSpot(l, rng, { want: 1.2 + rng() * 2.6, near: 1.8, far: 9.0 });
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

    /* --- level of detail ---
       Sorted by nothing: the frustum test throws away most of them and
       the budget takes the rest in scene order, which is stable frame
       to frame and therefore never flickers. */
    let live = 0;
    for (const h of all) {
      if (h.asleep) { h.root.visible = false; h.active = false; continue; }
      const d = h.root.position.distanceTo(_v);
      h.dist = d;
      if (d > FAR) { h.root.visible = false; h.active = false; continue; }
      /* THINNING, not culling. Quadrupling the population to make a
         square look inhabited also quadruples what a vista has to draw,
         and a figure past 110 m is a dozen pixels of colour that §2.4
         has already hazed toward #B8DEF0. So beyond THIN0 a stable,
         per-person fraction drops out — deterministic, so it never
         flickers, and graded, so the district in front of you keeps
         every one of its people. */
      if (d > THIN0 && h.lodKey > 1 - smoothstep(THIN0, FAR, d) * THIN_MAX) {
        h.root.visible = false; h.active = false; continue;
      }
      _sphere.center.copy(h.root.position);
      _sphere.center.y += h.height * 0.55;
      _sphere.radius = h.height * 0.66;
      const vis = _frustum.intersectsSphere(_sphere);
      h.root.visible = vis;
      const cast = vis && d < SHADOW_FAR;
      if (cast !== h._cast) { h._cast = cast; h.body.castShadow = cast; h.head.castShadow = cast; }
      h.active = vis && d < ANIM_FAR && live < budget;
      if (h.active) live++;
    }

    /* --- standers: named clients, and anyone the debug lineup froze.
       They notice Wally, turn toward him and hold his eye. --- */
    const wp = ctx.wally ? ctx.wally.position : null;
    for (const h of all) {
      if (h.agent && !h.agent.frozen) continue;      // the crowd owns them
      if (!h.active) continue;
      if (wp) {
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

    happyUpdate(dt, t);
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

  /* Blonde, fair, and built to be RECOGNISED later. Every field is a
     deliberate outlier against randomSpec()'s distribution: the quiff
     is one of seventeen hair styles and the only tall one, `platinum`
     the lightest of thirteen hair colours, `porcelain` the lightest of
     eight skins, and the hue is BRAND.token — the game's own orange,
     which no ambient wanderer can wear because randomSpec picks from a
     fourteen-colour list that does not contain it. So he is the only
     pale blond in orange on the island: one silhouette, one colour, no
     name tag needed. */
  const HAPPY_SPEC = {
    id: 'happy',
    n: 'Happy',
    role: 'Tokenizer',
    skin: 'porcelain',
    face: 'oval',
    hair: 'quiff',
    /* `blonde` (#C69A55), not `platinum` (#DCC9A4). Measured on the
       first render: platinum sits 6 % from `porcelain` skin (#F0D2BC)
       in luminance and 4 points in hue, so the quiff and the forehead
       fused into one pale mass and he read as a bald man with a cone on
       his head. A golden blonde is unambiguously HAIR against a fair
       face, which is the whole point of the description. */
    hairCol: 'blonde',
    beard: 'none',
    specs: 'none',
    hat: 'none',
    hue: '#F5913C',            // BRAND.token
    age: 1,
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

  /**
   * Run the encounter. Safe to call twice: the second call is ignored
   * while one is in flight.
   * @param {{instant?:boolean}} o  instant places him at the stop point
   *        already facing Wally — for the screenshot harness.
   */
  function playHappy(o = {}) {
    if (happy) return happy;
    const w = ctx.wally;
    if (!w) return null;
    const wp = w.position;
    const wyaw = w.rotation.y;

    happy = makeHuman(HAPPY_SPEC, 'npc.happy', 'fine');
    happy.name = 'Happy';
    happy.baseMode = 'idle';
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
      happy.body.material = m;
      happy.head.material = m;
      /* It is transparent now, so the normal+depth prepass would leave
         it on its own material and it would write colour into the
         buffer that the DOF and the ground shadow both read. */
      happy.body.userData.noPrepass = true;
      happy.head.userData.noPrepass = true;
      happy.body.castShadow = false;
      happy.head.castShadow = false;
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

  dbg.npcRelease = () => {
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
       Swung 26 degrees round toward Happy, their silhouettes just
       overlap and the composition closes. */
    const a = Math.atan2(hp.x - wp.x, hp.z - wp.z) + Math.PI / 2 - 0.45;
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
