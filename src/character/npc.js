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
  const humans = createHumans(ctx);

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
    return best;
  }

  /* ------------------------------------------------------------
     Build one person
     ------------------------------------------------------------ */
  function makeHuman(spec, seed, detail) {
    const h = humans.build(spec, seed, detail);
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
    return h;
  }

  /* ------------------------------------------------------------
     The 24 named clients
     ------------------------------------------------------------ */
  function spawnClient(id, pos) {
    const c = CLIENT_BY_ID[id];
    if (!c) { console.warn(`[npc] no client "${id}"`); return null; }
    if (named.has(id)) return named.get(id);
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
    /* Named clients are the only people the camera ever frames from a
       metre away, so they are the only ones that get the fine mesh. */
    const h = makeHuman(spec, 'client.' + id, 'fine');

    let p = pos;
    if (!p) {
      /* their home is a district; stand them by a location inside it */
      const locs = LOCATIONS.filter((l) => l.z === c.home);
      const z = ZONES[c.home];
      const anchor = locs.length
        ? locs[Math.floor(rng() * locs.length) % locs.length]
        : null;
      const ref = anchor || { id: null, world: { x: z ? z.world.x : 0, z: z ? z.world.z : 0 }, radius: 16 };
      p = standingSpot(ref, rng, { near: 2.0, far: 6.0 });
      h.homeLoc = anchor ? anchor.id : null;
      h.baseYaw = p.yaw;
    } else {
      p = { x: p.x, y: p.y ?? groundY(p.x, p.z), z: p.z };
      h.baseYaw = rng() * Math.PI * 2;
    }
    h.root.position.set(p.x, p.y, p.z);
    h.root.rotation.y = h.baseYaw;
    h.home = new THREE.Vector3(p.x, p.y, p.z);
    h.isClient = true;
    /* a shopkeeper works, a customer waits, a coach stands and glares */
    const mode = c.role && /owner|barista|driver|dispatcher|engineer|researcher|artist/i.test(c.role)
      ? (rng() < 0.5 ? 'work' : 'idle') : 'idle';
    h.baseMode = mode;
    h.anim.setMode(mode);
    named.set(id, h);
    return h;
  }

  /* ------------------------------------------------------------
     The ambient crowd
     ------------------------------------------------------------ */
  const crowd = createCrowd(ctx, { groundY, roadLift });
  const crowdRng = ctx.makeRng('npc.crowd.spec');
  let crowdTarget = 0;

  function spawnCrowd(n) {
    let made = 0;
    for (let i = 0; i < n; i++) {
      const spec = randomSpec(crowdRng, 'crowd' + (crowd.agents.length + i));
      const h = makeHuman(spec, 'crowd.' + (all.length), 'coarse');
      const a = crowd.add(h);
      if (!a) { h.dispose(); all.pop(); break; }
      h.agent = a;
      made++;
    }
    return made;
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

  function spawnResidents(perLoc) {
    const rng = ctx.makeRng('npc.residents.v2');
    let made = 0;
    for (const l of LOCATIONS) {
      if (l.id === 'apartment' || l.kit === 'interior' && rng() < 0.5) continue;
      const plaza = PLAZA_KIT.has(l.kit);
      const n = 1 + Math.floor(rng() * perLoc * (plaza ? 1.5 : 1));
      for (let i = 0; i < n; i++) {
        const spec = randomSpec(rng, 'res.' + l.id + '.' + i);
        const h = makeHuman(spec, 'res.' + l.id + '.' + i, 'coarse');
        const p = plaza
          ? standingSpot(l, rng, { want: 1.4 + rng() * 3.4, near: 3.0, far: 22 + rng() * 6, tries: 34 })
          : standingSpot(l, rng, { want: 1.2 + rng() * 2.6, near: 1.8, far: 9.0 });
        h.root.position.set(p.x, p.y, p.z);
        h.baseYaw = p.yaw;
        h.root.rotation.y = h.baseYaw;
        h.home = new THREE.Vector3(p.x, p.y, p.z);
        h.homeLoc = l.id;
        const r = rng();
        const mode = r < 0.30 ? 'work' : r < 0.50 ? 'talk' : r < 0.60 ? 'sit' : 'idle';
        h.baseMode = mode;
        h.anim.setMode(mode);
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

    updatePrompt(dt);
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
    spawnCrowd(n) { return spawnCrowd(n | 0); },

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
      const h = named.get(id) || all.find((x) => x.id === id);
      if (!h) return null;
      if (!target) { h.anim.lookTarget = null; h.anim.lookW = 0; h.lookW = 0; return h; }
      h.anim.lookTarget = target.isVector3 ? target.clone()
        : new THREE.Vector3(target.x, target.y ?? 1.4, target.z);
      h.anim.lookW = 1; h.lookW = 1;
      return h;
    },

    /** A line over their head, and a gesture to go with it. */
    say(id, text, ttl = 3.6) {
      const h = named.get(id) || all.find((x) => x.id === id);
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
      const h = named.get(id);
      if (!h || !h.client) return null;
      if (ctx.ui?.talkTo) ctx.ui.talkTo(h.client);
      h.anim.setMode('talk');
      h.sayT = 4;
      return h;
    },

    /** Pose someone by hand: 'idle' | 'walk' | 'talk' | 'sit' | 'work' | 'wave' */
    setMode(id, mode) {
      const h = named.get(id) || all.find((x) => x.id === id);
      if (h) h.anim.setMode(mode);
      return h;
    },

    get count() { return all.length; },
    stats: humans.stats,

    update,
    dispose() {
      if (typeof window !== 'undefined') removeEventListener('keydown', onKey);
      for (const h of all) h.dispose();
      all.length = 0;
      named.clear();
      humans.dispose();
      ctx.scene.remove(root);
    },
  };

  /* ------------------------------------------------------------
     Boot: everyone in place
     ------------------------------------------------------------ */
  for (const c of CLIENTS) spawnClient(c.id);

  /* HOW MANY PEOPLE IS A TOWN. 153 spread over a 900 m island put ONE
     figure in the default 78 m framing of the market square and four at
     34 m: the square read as an evacuated diorama with Wally alone in a
     field, which is the one thing this module exists to prevent. A
     wanderer costs 1.3 ms to build and two draw calls when it is in
     frame, the 46-skeleton animation budget already caps the per-frame
     cost by distance, and everything past FAR is hidden outright — so
     the honest limit is boot time, and 350 people is half a second. */
  const baseCrowd = Math.round(clamp(40 + (q.particles ?? 1) * 140, 24, 180));
  spawnCrowd(baseCrowd);
  spawnResidents(q.particles >= 0.9 ? 12 : q.particles >= 0.5 ? 7 : 3);

  /* mode variety across the standing clients so a district is not a
     row of statues in the same pose */
  {
    const rng = ctx.makeRng('npc.modes');
    for (const h of named.values()) {
      const r = rng();
      if (h.baseMode === 'work') continue;
      if (r < 0.14) { h.anim.setMode('sit'); h.baseMode = 'sit'; }
      else if (r < 0.24) { h.anim.setMode('work'); h.baseMode = 'work'; }
    }
  }

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
    const h = named.get(id);
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
      let h = named.get(ids[i % ids.length]);
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
    const h = named.get(id);
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
      total: all.length, named: named.size, crowd: crowd.agents.length,
      live: all.filter((h) => h.active).length,
      visible: vis, visibleTris: tris, shadowCasterTris: cast,
      bodyTris: humans.stats.bodyTriangles,
      bodyTrisCoarse: humans.stats.bodyTrianglesCoarse,
      buildMs: humans.stats.buildMs,
    };
  };
  dbg.npcSay = (id, text) => api.say(id, text || 'Morning, Wally.');
  dbg.npcMode = (id, m) => api.setMode(id, m);
  if (window.WALLY) window.WALLY.debug = dbg;

  /* camera.js is the authority while an override is live (it writes
     exactly what it was handed and touches nothing else), so this is
     only the belt to its braces for the frame the override is set. */
  api.lateUpdate = () => { if (camState && !ctx.cam) applyCam(); };

  console.log(`[npc] ${all.length} people (${named.size} named, ${crowd.agents.length} crowd) `
    + `${humans.stats.bodyTriangles} body tris, ${humans.stats.bones} bones, `
    + `${(performance.now() - t0).toFixed(0)} ms`);

  return api;
}

export default init;
