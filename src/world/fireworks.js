/* ============================================================
   fireworks.js — THE HUNDRED-PERCENT SHOW.

   game/quests.js emits 'city:tokenized' once the last of the 69
   assets is tokenized, and its payload carries `durationMs`
   (CONFIG.fireworksMs — one minute). This is what that minute looks
   like: a city-wide fireworks display launched from ~30 pads spread
   across all ten districts, built out of real shells.

   WHAT A SHELL IS HERE
   ------------------------------------------------------------
   A shell is not a puff of sprites. It is a lifted mortar flash, a
   rising comet that leaves a tapering streak of sparks, a fuse, a
   BREAK, and then a few hundred sparks that arc under gravity with
   air drag, twinkle, shed glitter and burn down from white-hot
   through their own colour to a dead ember. Six break patterns —

     peony       even sphere, the classic. Bright, medium hang.
     ring        sparks on a disc turned to FACE the camera, so the
                 shape actually reads instead of collapsing to a blob.
     willow      slow, heavy, long-lived gold trails that fall and
                 shed glitter the whole way down.
     palm        a dozen fat fronds — fewer, thicker, glittering.
     crackle     a tight fast burst that pops a second time 0.3 s
                 later into a swarm of hard-strobing white sparks.
     multibreak  five to seven comets thrown out on their own fuses,
                 each breaking again in a different colour.

   COST
   ------------------------------------------------------------
   TWO draw calls, whatever is happening. Every spark, glitter, trail
   and burst flash lives in ONE pooled, swap-removed typed-array
   simulation behind ONE geometry; two Points objects draw it, one for
   the sparks and one for the additive sky-wash flashes, each culling
   the other's vertices in its vertex shader. The pool is a hard
   ceiling (ctx.quality): a spawn that would exceed it is simply
   dropped, so the finale degrades in density and never in frame time.
   Sparks are chunky rounded quads with a hot core, not thin streaks
   (ART_DIRECTION §0 — stylised, saturated), emitted at HDR values
   well past the bloom prefilter's 1.7 threshold so the post chain's
   bloom does the glow for us.

   LIGHT
   ------------------------------------------------------------
   A break tints the world. `light` accumulates every live burst into
   one colour and strength; city.js pushes it into ctx.mat's ambient
   AFTER sky.js has written the frame's base values, so a burst puts
   its own colour on the rooftops and the whole sky lifts. sky.js
   rewrites the base every frame, so nothing here can ever stick.

   OWNERSHIP: world agent. Reaches ctx.audio only through its public
   sfx() — no audio file is touched.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BRAND, SKY, SEA, LAND } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';
import { ZONES, LOCATIONS } from '../game/data.js';

const PI = Math.PI;
const TAU = PI * 2;

/* ------------------------------------------------------------------
   Colour. Every firework colour is a recipe over palette.js — never a
   fresh hex (BUILD_BRIEF). Saturated and stylised, per §2.1.
   ------------------------------------------------------------------ */
const mix = (a, b, t) => {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((Math.round(lerp(ar, br, t)) << 16)
        | (Math.round(lerp(ag, bg, t)) << 8)
        |  Math.round(lerp(ab, bb, t)));
};
/* Pushed away from their own luminance: a firework is the most
   saturated thing in the frame by a distance. */
const sat = (h, k) => {
  const r = (h >> 16) & 255, g = (h >> 8) & 255, b = h & 255;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const f = (v) => clamp(Math.round(y + (v - y) * k), 0, 255);
  return (f(r) << 16) | (f(g) << 8) | f(b);
};

const HUE = {
  token:   sat(BRAND.token, 1.30),
  ember:   sat(BRAND.token2, 1.30),
  gold:    sat(mix(BRAND.warn, SKY.sunDisc, 0.30), 1.20),
  rose:    sat(mix(BRAND.bad, BRAND.gem, 0.28), 1.35),
  violet:  sat(BRAND.gem, 1.40),
  azure:   sat(mix(BRAND.info, SEA.shallow, 0.40), 1.35),
  jade:    sat(mix(BRAND.good, SEA.shallow, 0.26), 1.35),
  lime:    sat(mix(LAND.grassLit, BRAND.warn, 0.30), 1.30),
  cream:   mix(BRAND.paper, SKY.sunDisc, 0.45),
  magenta: sat(mix(BRAND.bad, BRAND.gem, 0.55), 1.45),
  ice:     sat(mix(SEA.caustic, BRAND.paper, 0.35), 1.15),
};

/* Themes are PAIRS. A shell breaks in its first colour and its
   glitter, crackle and secondary breaks land in the second, which is
   what stops a minute of fireworks reading as one hue per pop. */
const THEMES = [
  [HUE.token,   HUE.gold],
  [HUE.violet,  HUE.ice],
  [HUE.azure,   HUE.cream],
  [HUE.jade,    HUE.gold],
  [HUE.rose,    HUE.cream],
  [HUE.magenta, HUE.violet],
  [HUE.gold,    HUE.ember],
  [HUE.lime,    HUE.cream],
  [HUE.ice,     HUE.azure],
  [HUE.ember,   HUE.token],
];

/* Break patterns. `n` is the spark count at quality 1.0. */
const TYPES = {
  peony:  { n: 130, speed: 22.0, life: [2.3, 3.2], drag: 1.15, grav: 0.62, tw: 0.55, glit: 0.00, size: 2.30, flash: 34 },
  ring:   { n: 98,  speed: 23.5, life: [2.5, 3.3], drag: 0.95, grav: 0.52, tw: 0.40, glit: 0.00, size: 2.35, flash: 30 },
  willow: { n: 78,  speed: 16.0, life: [3.1, 4.2], drag: 0.42, grav: 1.05, tw: 0.20, glit: 0.34, size: 2.55, flash: 36 },
  palm:   { n: 32,  speed: 18.0, life: [2.7, 3.5], drag: 0.50, grav: 0.95, tw: 0.16, glit: 0.72, size: 3.00, flash: 34 },
  crackle:{ n: 160, speed: 17.0, life: [0.9, 1.4], drag: 1.80, grav: 0.50, tw: 1.00, glit: 0.00, size: 2.00, flash: 30 },
};
const TYPE_NAMES = ['peony', 'ring', 'willow', 'palm', 'crackle', 'multibreak'];

/* particle flags */
const F_TWINKLE = 1;
const F_GLITTER = 2;
const F_FLASH   = 4;   // no physics, huge, short — the sky wash
const F_TRAIL   = 8;   // a rising comet's tail: short, hot, low drag

export function createFireworks(ctx) {
  const q = ctx.quality || {};
  const tier = q.name || 'high';

  /* THE BUDGET. A hard ceiling, not a target: over it, spawns are
     dropped. Low still gets every shell of the show, at 62 % of the
     spark density — the structure of the minute is not a luxury. */
  const CAP = tier === 'low' ? 1300 : tier === 'med' ? 2200 : /^ultra/.test(tier) ? 4400 : 3200;
  const DENS = clamp(0.45 + (q.particles ?? 1) * 0.55, 0.55, 1.35);
  const MAX_SHELLS = tier === 'low' ? 26 : 64;

  /* ================================================================
     1. The pool. Structure-of-arrays, swap-removed.
     ================================================================ */
  const pos  = new Float32Array(CAP * 3);   // the render attribute
  const col  = new Float32Array(CAP * 3);   // the render attribute
  const siz  = new Float32Array(CAP);       // the render attribute
  const vx = new Float32Array(CAP), vy = new Float32Array(CAP), vz = new Float32Array(CAP);
  const cr = new Float32Array(CAP), cg = new Float32Array(CAP), cb = new Float32Array(CAP);
  const age = new Float32Array(CAP), lif = new Float32Array(CAP);
  const s0  = new Float32Array(CAP), br0 = new Float32Array(CAP);
  const drg = new Float32Array(CAP), grv = new Float32Array(CAP);
  const twk = new Float32Array(CAP), pha = new Float32Array(CAP);
  const emt = new Float32Array(CAP), erate = new Float32Array(CAP);
  const flg = new Uint8Array(CAP);
  const knd = new Float32Array(CAP);        // render attribute: 0 spark, 1 flash
  const gr = new Float32Array(CAP), gg = new Float32Array(CAP), gb = new Float32Array(CAP);
  let live = 0;

  const _c = new THREE.Color();
  /** sRGB hex -> linear rgb triple (everything downstream is linear). */
  function lin(hex, out) {
    _c.setHex(hex, THREE.SRGBColorSpace);
    out[0] = _c.r; out[1] = _c.g; out[2] = _c.b;
    return out;
  }
  /* Scratch colour triples. Nothing here allocates per particle: a
     minute of fireworks spawns tens of thousands of sparks and a
     three-element array each would be the only garbage in the frame. */
  const _l0 = [0, 0, 0], _l1 = [0, 0, 0], _lt = [0, 0, 0], _lg = [0, 0, 0];

  function kill(i) {
    const j = --live;
    if (i !== j) {
      pos[i * 3] = pos[j * 3]; pos[i * 3 + 1] = pos[j * 3 + 1]; pos[i * 3 + 2] = pos[j * 3 + 2];
      vx[i] = vx[j]; vy[i] = vy[j]; vz[i] = vz[j];
      cr[i] = cr[j]; cg[i] = cg[j]; cb[i] = cb[j];
      gr[i] = gr[j]; gg[i] = gg[j]; gb[i] = gb[j];
      age[i] = age[j]; lif[i] = lif[j]; s0[i] = s0[j]; br0[i] = br0[j];
      drg[i] = drg[j]; grv[i] = grv[j]; twk[i] = twk[j]; pha[i] = pha[j];
      emt[i] = emt[j]; erate[i] = erate[j]; flg[i] = flg[j]; knd[i] = knd[j];
    }
  }

  /** @returns index, or -1 when the budget is spent. */
  function spawn(x, y, z, ivx, ivy, ivz, c, size, life, o) {
    if (live >= CAP) { dropped++; return -1; }
    const i = live++;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    vx[i] = ivx; vy[i] = ivy; vz[i] = ivz;
    cr[i] = c[0]; cg[i] = c[1]; cb[i] = c[2];
    age[i] = 0; lif[i] = life; s0[i] = size;
    br0[i] = o.bright ?? 2.0;
    drg[i] = o.drag ?? 1.1;
    grv[i] = o.grav ?? 0.7;
    twk[i] = o.tw ?? 0;
    pha[i] = rnd() * TAU;
    flg[i] = o.flags ?? 0;
    knd[i] = (flg[i] & F_FLASH) ? 1 : 0;
    erate[i] = o.erate ?? 0;
    emt[i] = 0;
    const g = o.glitCol || c;
    gr[i] = g[0]; gg[i] = g[1]; gb[i] = g[2];
    return i;
  }

  /* ================================================================
     2. The material. Chunky rounded sparks with a white-hot core,
        additive, fog-ATTENUATED (a distant shell dims into the haze;
        it does not turn haze-blue, which is what a fog blend would do
        to an emissive additive sprite).
     ================================================================ */
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  geo.setAttribute('aKind', new THREE.BufferAttribute(knd, 1));
  geo.setDrawRange(0, 0);
  /* The show is city-wide: never let a bounding sphere cull it. */
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 60, 0), 4000);

  const uni = {
    uScale:   { value: 700 },
    /* THE FILL-RATE GOVERNOR. A burst flash is tens of metres across:
       unclamped, one of them near the lens is a full-screen alpha-blended
       quad in an RGBA16F target, and the whole minute is fill-bound long
       before it is CPU-bound. 60 px is the measured knee. */
    uMaxSize: { value: tier === 'low' ? 44 : 60 },
    uCore:    { value: 0.42 },
    uFog:     { value: new THREE.Vector2(100, 520) },
    uDim:     { value: 1.0 },
  };

  /* ------------------------------------------------------------------
     WHY THE SPARKS ARE NOT ADDITIVE.

     They were, and against a Wind Waker daylight sky every colour in
     the show came out paper white — measured, not guessed. Additive
     is `sky + spark`, so the sky's own blue is still in the result;
     push the spark hard enough to beat it and all three channels
     clip together, which IS white. Ten colour themes may as well not
     have existed.

     Sparks therefore composite PREMULTIPLIED OVER, with an alpha
     driven by their own brightness:

       bright spark   alpha -> 1, and it REPLACES the sky with its own
                      HDR colour. Saturated orange stays orange.
       dying ember    alpha -> 0, and `rgb` alone survives, which is
                      exactly additive again — a glint, not a black dot.

     One model, both ends of the burn, and the HDR values still clear
     the bloom prefilter at 1.7 so the post chain does the glow.

     The burst FLASH is a different thing — a wash of light on the sky
     — so it keeps additive blending, in a second Points that shares
     this same geometry and simply culls the vertices that are not its
     own. Two draw calls for the entire show.
     ------------------------------------------------------------------ */
  const VERT = (want) => /* glsl */`
      attribute vec3  aCol;
      attribute float aSize;
      attribute float aKind;
      uniform float uScale;
      uniform float uMaxSize;
      uniform vec2  uFog;
      varying vec3  vCol;
      varying float vFog;
      void main() {
        if ( abs( aKind - ${want}.0 ) > 0.5 ) {
          /* not ours: park it outside the clip volume */
          gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
          gl_PointSize = 0.0;
          vCol = vec3( 0.0 ); vFog = 0.0;
          return;
        }
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        float d = max( -mv.z, 0.6 );
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp( aSize * uScale / d, 1.5, uMaxSize );
        vCol = aCol;
        /* Attenuate, don't blend: haze eats a distant burst's energy,
           it does not turn it haze-blue. */
        vFog = 1.0 - clamp( ( d - uFog.x ) / max( uFog.y - uFog.x, 1.0 ), 0.0, 1.0 ) * 0.52;
      }
  `;

  const SHAPE = /* glsl */`
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float rc = length( p );
        float sq = max( abs( p.x ), abs( p.y ) );
        /* CHUNKY, not thin: a rounded square, mostly solid, with a
           short soft rim. §0 — stylised, not photoreal. */
        float shape = mix( rc, sq, 0.42 );
        float m = 1.0 - smoothstep( 0.52, 1.0, shape );
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms: uni,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,                    // premultiplied
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    vertexShader: VERT(0),
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uCore;
      uniform float uDim;
      varying vec3  vCol;
      varying float vFog;
      void main() {
        ${SHAPE}
        if ( m <= 0.004 ) discard;
        vec3 c = vCol * vFog * uDim;
        float lum = max( c.r, max( c.g, c.b ) );
        /* A HOT CORE, NOT A WHITE SPARK. Capped, because c is HDR:
           uncapped, this term scaled with the spark's own brightness
           and bleached the whole show back to white again. */
        c += vec3( 1.0 ) * pow( m, 8.0 ) * uCore * min( lum, 1.3 );
        float a = clamp( m * lum * 1.45, 0.0, 1.0 );
        gl_FragColor = vec4( c * m, a );
      }
    `,
  });

  /* the sky wash behind a break — additive, and drawn first */
  const flashMat = new THREE.ShaderMaterial({
    uniforms: uni,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: VERT(1),
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uDim;
      varying vec3  vCol;
      varying float vFog;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = length( p );
        float m = 1.0 - smoothstep( 0.0, 1.0, r );
        m = m * m;
        if ( m <= 0.002 ) discard;
        gl_FragColor = vec4( vCol * m * vFog * uDim, 1.0 );
      }
    `,
  });

  const flashPoints = new THREE.Points(geo, flashMat);
  flashPoints.name = 'fireworks.flash';
  flashPoints.frustumCulled = false;
  flashPoints.renderOrder = 11;
  flashPoints.visible = false;
  ctx.scene.add(flashPoints);

  const points = new THREE.Points(geo, mat);
  points.name = 'fireworks';
  points.frustumCulled = false;
  points.renderOrder = 12;
  points.visible = false;
  ctx.scene.add(points);

  /* one switch for both halves of the show */
  const show = (on) => { points.visible = on; flashPoints.visible = on; };

  /* ================================================================
     3. Launch pads — spread ACROSS THE CITY.
        Three per district, off the district anchor, plus the
        landmarks that read from a distance. Deterministic.
     ================================================================ */
  const prng = ctx.makeRng ? ctx.makeRng('wally.fireworks.pads') : Math.random;
  const pads = [];
  function addPad(x, z, lift, name) {
    const g = ctx.world?.heightAt ? ctx.world.heightAt(x, z) : 0;
    if (!Number.isFinite(g)) return;
    pads.push({ x, z, y: g + lift, name });
  }
  for (const zid of Object.keys(ZONES)) {
    const z = ZONES[zid];
    const R = Math.max(34, (z.world.radius || 90) * 0.46);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + prng() * 1.1;
      const r = R * (0.30 + prng() * 0.85);
      addPad(z.world.x + Math.sin(a) * r, z.world.z + Math.cos(a) * r,
        4 + prng() * 13, zid);
    }
  }
  /* Rooftop mortars on the landmarks — the ones you can see from the
     other side of the island. */
  for (const id of ['stadium', 'exchange', 'penthouse', 'docks', 'treasury', 'markethall', 'school', 'mine']) {
    const l = LOCATIONS.find((x) => x.id === id);
    if (l) addPad(l.world.x, l.world.z, (l.size?.h || 12) * 0.85, id);
  }
  /* AND THE GROUND BETWEEN THE DISTRICTS. Ten districts on a 970 m
     island leaves eighty-metre gaps, and a player standing in one of
     them — the opening spawn is exactly that — had every pad in the
     game either 200 m away or behind him. A jittered grid over the
     dry land fills those gaps, so wherever he stops there is always a
     mortar at a distance that frames. */
  {
    const R = 380, N = 9;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -R + (2 * R * (i + 0.5)) / N + (prng() - 0.5) * 70;
        const z = -R + (2 * R * (j + 0.5)) / N + (prng() - 0.5) * 70;
        const h = ctx.world?.heightAt ? ctx.world.heightAt(x, z) : 0;
        if (!(h > 2.5)) continue;                       // sea, or the beach
        /* not on top of a building, and not doubled up on a district pad */
        if (pads.some((q) => Math.hypot(q.x - x, q.z - z) < 42)) continue;
        addPad(x, z, 3 + prng() * 8, 'field');
      }
    }
  }

  /* The city's own centre of mass — where the camera is asked to look
     and where the finale's biggest shells break. */
  const hub = { x: 0, z: 0 };
  {
    let n = 0;
    for (const l of LOCATIONS) { hub.x += l.world.x; hub.z += l.world.z; n++; }
    hub.x /= n; hub.z /= n;
  }

  /* ================================================================
     4. Shells in flight. A small object list — never more than a few
        dozen — integrated by hand so a comet's tail can be emitted
        from its own path rather than chased through the pool.
     ================================================================ */
  const shells = [];
  const G_RISE = 34.0;          // shell-rise gravity: readable, not real

  let rng = ctx.makeRng ? ctx.makeRng('wally.fireworks.show') : Math.random;
  const rnd = () => rng();
  const rr = (a, b) => a + (b - a) * rng();
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];

  const _cam = new THREE.Vector3();
  const _w = new THREE.Vector3();   // ctx.wind.vector writes through .set()

  /* ---- the light a break throws on the town ---- */
  const light = { r: 0, g: 0, b: 0, k: 0 };
  function addLight(c, strength) {
    /* Weighted accumulation: two simultaneous breaks make one colour,
       not two fighting ones. */
    const k = light.k + strength;
    if (k <= 0) return;
    light.r = (light.r * light.k + c[0] * strength) / k;
    light.g = (light.g * light.k + c[1] * strength) / k;
    light.b = (light.b * light.k + c[2] * strength) / k;
    light.k = Math.min(k, 1.6);
  }

  /* ---- sound, through ctx.audio's public sfx() only ---- */
  let sfxBudget = 0;
  function boom(x, y, z, kind, gain) {
    const a = ctx.audio;
    if (!a || !a.sfx) return;
    if (sfxBudget <= 0) return;
    sfxBudget--;
    ctx.camera.getWorldPosition(_cam);
    const dx = x - _cam.x, dy = y - _cam.y, dz = z - _cam.z;
    const dist = Math.hypot(dx, dy, dz);
    const delay = clamp(dist / 340, 0, 1.4);                 // speed of sound
    const att = clamp(1 - dist / 900, 0.05, 1) ** 1.5;
    /* stereo placement from the camera's own right vector */
    const m = ctx.camera.matrixWorld.elements;
    const pan = clamp((dx * m[0] + dy * m[1] + dz * m[2]) / Math.max(dist, 1), -1, 1);
    if (kind === 'launch') {
      a.sfx('whoosh', { gain: 0.30 * att, pitch: rr(1.35, 1.75), pan, delay, vary: 0.1 });
    } else if (kind === 'crackle') {
      a.sfx('break', { gain: 0.34 * att * gain, pitch: rr(1.2, 1.6), pan, delay });
    } else {
      a.sfx('thunder', { gain: 0.30 * att * gain, pitch: rr(0.85, 1.15), pan, delay });
      a.sfx('break', { gain: 0.16 * att * gain, pitch: rr(1.0, 1.35), pan, delay: delay + 0.03 });
    }
  }

  /* ================================================================
     5. BREAKS
     ================================================================ */
  function flash(x, y, z, c, size, bright, life) {
    spawn(x, y, z, 0, 0, 0, c, size, life, {
      bright, drag: 0, grav: 0, flags: F_FLASH,
    });
  }

  function sphereDir(out) {
    /* even on the sphere, not clustered at the poles */
    const u = rng() * 2 - 1, a = rng() * TAU;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    out[0] = Math.cos(a) * s; out[1] = u; out[2] = Math.sin(a) * s;
    return out;
  }
  const _d = [0, 0, 0];
  const _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _az = new THREE.Vector3();


  /* A SPARK IS A STREAK, NOT A DOT.

     A point sprite cannot be stretched along its own velocity, and a
     burst drawn as a swarm of separate dots reads as confetti. So a
     spark is spawned as a short COMET: the head, plus two smaller,
     shorter-lived followers laid back along its own velocity vector
     and given a little more drag, so the streak trails, shortens as
     the head slows, and is gone before the head is. Three particles
     for a mark that reads as one — measured cheaper than emitting a
     trail continuously, and it never depends on the frame rate. */
  function comet(x, y, z, ivx, ivy, ivz, c, size, life, o) {
    const h = spawn(x, y, z, ivx, ivy, ivz, c, size, life, o);
    if (h < 0) return h;
    /* UNDER PRESSURE, DROP THE STREAK AND KEEP THE BURST. The pool
       saturates in the finale (measured: 3585 of 3600 live, 8 % of
       spawns refused), and losing whole SPARKS there thins the shape
       of every shell. Losing only their tails costs a third of the
       particles and almost none of the read. */
    if (live > CAP * 0.70) return h;
    for (let t = 1; t <= 2; t++) {
      const k = t * 0.052;
      spawn(x - ivx * k, y - ivy * k, z - ivz * k, ivx, ivy, ivz, c,
        size * (t === 1 ? 0.66 : 0.44), life * (t === 1 ? 0.62 : 0.42),
        { ...o, drag: (o.drag ?? 1.1) * (1 + t * 0.35), erate: 0, flags: (o.flags ?? 0) & ~F_GLITTER });
    }
    return h;
  }

  function burst(x, y, z, typeName, colA, colB, scale = 1) {
    const T = TYPES[typeName] || TYPES.peony;
    const cA = lin(colA, _l0);
    const cB = lin(colB, _l1);

    /* THE WASH OF LIGHT on the sky and on the rooftops. It outlives
       the sparks' first half-second on purpose: between shells it is
       what keeps colour in the sky rather than an empty blue gap. */
    flash(x, y, z, cA, T.flash * scale, 0.72, 0.95);
    flash(x, y, z, cA, T.flash * scale * 1.6, 0.30, 1.1);
    addLight(cA, clamp(0.34 * scale, 0.1, 0.7));
    boom(x, y, z, typeName === 'crackle' ? 'crackle' : 'boom', clamp(scale, 0.5, 1.6));

    const n = Math.max(10, Math.round(T.n * DENS * scale));
    const sp = T.speed * (0.85 + 0.3 * scale);

    if (typeName === 'ring') {
      /* Turn the disc to FACE the camera, or the shape is a blob. */
      ctx.camera.getWorldPosition(_cam);
      _az.set(_cam.x - x, (_cam.y - y) * 0.35, _cam.z - z);
      if (_az.lengthSq() < 1e-4) _az.set(0, 0, 1);
      _az.normalize();
      _ax.set(0, 1, 0).cross(_az);
      if (_ax.lengthSq() < 1e-4) _ax.set(1, 0, 0);
      _ax.normalize();
      _ay.copy(_az).cross(_ax).normalize();
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + rr(-0.03, 0.03);
        const s = sp * rr(0.94, 1.06);
        const ca = Math.cos(a) * s, sa = Math.sin(a) * s;
        const jx = _az.x * rr(-1.6, 1.6), jy = _az.y * rr(-1.6, 1.6), jz = _az.z * rr(-1.6, 1.6);
        comet(x, y, z,
          _ax.x * ca + _ay.x * sa + jx,
          _ax.y * ca + _ay.y * sa + jy,
          _ax.z * ca + _ay.z * sa + jz,
          i % 7 === 0 ? cB : cA, T.size * rr(0.85, 1.2), rr(T.life[0], T.life[1]),
          { drag: T.drag, grav: T.grav, tw: T.tw, bright: 2.1, flags: F_TWINKLE });
      }
      return;
    }

    if (typeName === 'palm') {
      /* Fat fronds, not a shell of dust: a handful of thick sparks,
         every one of them shedding glitter the whole way. */
      for (let i = 0; i < n; i++) {
        sphereDir(_d);
        _d[1] = Math.abs(_d[1]) * 0.75 + 0.30;      // thrown up and out
        const s = sp * rr(0.85, 1.15);
        comet(x, y, z, _d[0] * s, _d[1] * s, _d[2] * s, cA,
          T.size * rr(0.9, 1.35), rr(T.life[0], T.life[1]),
          {
            drag: T.drag, grav: T.grav, tw: T.tw, bright: 2.2,
            flags: F_TWINKLE | F_GLITTER, erate: 15, glitCol: cB,
          });
      }
      return;
    }

    for (let i = 0; i < n; i++) {
      sphereDir(_d);
      /* a shell of sparks with a soft inner core, not a hollow skin */
      const s = sp * (0.55 + 0.45 * Math.cbrt(rng())) * rr(0.9, 1.12);
      const glit = typeName === 'willow' && rng() < T.glit;
      (typeName === 'crackle' ? spawn : comet)(x, y, z, _d[0] * s, _d[1] * s, _d[2] * s,
        rng() < 0.16 ? cB : cA,
        T.size * (0.52 + 1.0 * rng() * rng()), rr(T.life[0], T.life[1]),
        {
          drag: T.drag, grav: T.grav, tw: T.tw,
          bright: typeName === 'crackle' ? 2.5 : 2.0,
          flags: F_TWINKLE | (glit ? F_GLITTER : 0),
          erate: glit ? 11 : 0, glitCol: cB,
        });
    }

    /* CRACKLE pops a second time. */
    if (typeName === 'crackle') {
      /* colB is re-resolved inside the closure: the scratch triples are
         reused by every other break in the 300 ms until this one runs. */
      pending.push({ t: 0.30, fn: () => {
        const m = Math.max(12, Math.round(70 * DENS * scale));
        const c2 = lin(colB, _l1);
        flash(x, y, z, c2, 16 * scale, 0.4, 0.24);
        boom(x, y, z, 'crackle', 0.6);
        for (let i = 0; i < m; i++) {
          sphereDir(_d);
          const s = rr(7, 19);
          spawn(x, y, z, _d[0] * s, _d[1] * s, _d[2] * s, c2,
            0.72 * rr(0.7, 1.2), rr(0.34, 0.66),
            { drag: 2.6, grav: 0.4, tw: 1.4, bright: 3.0, flags: F_TWINKLE });
        }
      } });
    }
  }

  /* deferred one-shots (crackle's second pop, finale beats) */
  const pending = [];

  /* ================================================================
     6. SHELLS — the rise, the fuse, the break.
     ================================================================ */
  /* HOW HIGH THIS ONE GOES — solved from where the camera is standing.

     A fixed apex is what killed the first pass of this: a shell 150 m
     away breaking 70 m up sits 25 degrees above the horizon, and the
     follow rig's frame stops at about 16, so the whole show happened
     over the top edge of the screen. Height is therefore a FRACTION OF
     THE DISTANCE to the lens — i.e. an ANGLE — which puts a near
     shell low and a shell across the island genuinely high, and both
     of them inside the frame the player is actually looking at. */
  function apexFor(pad, lo, hi) {
    ctx.camera.getWorldPosition(_cam);
    const D = Math.hypot(pad.x - _cam.x, pad.z - _cam.z);
    /* The follow rig sits about nine degrees nose-down with a fifty
       degree vertical field, so the frame runs from -34 to +16 degrees
       and the sky the player is actually looking at is the band from
       +3 to +16. tan of that band is 0.05 to 0.29 — which is where
       these fractions come from, and why they look small. */
    return clamp(D * rr(lo, hi) - (_cam.y - pad.y) * 0.5, 26, 115);
  }

  function launch(o) {
    if (shells.length >= MAX_SHELLS) return null;
    const pad = o.pad || pick(pads);
    if (!pad) return null;
    const apex = o.apex ?? apexFor(pad, 0.14, 0.26);
    const v = Math.sqrt(2 * G_RISE * apex);
    const a = rng() * TAU;
    const drift = o.drift ?? rr(0.5, 3.6);
    const type = o.type || pick(TYPE_NAMES);
    const theme = o.theme || pick(THEMES);
    const sh = {
      x: pad.x + rr(-3, 3), y: pad.y, z: pad.z + rr(-3, 3),
      vx: Math.sin(a) * drift, vy: v, vz: Math.cos(a) * drift,
      fuse: v / G_RISE * (o.fuseK ?? rr(0.92, 1.0)),
      t: 0, emit: 0,
      type, colA: theme[0], colB: theme[1],
      scale: o.scale ?? 1,
      child: !!o.child,
    };
    shells.push(sh);
    launched++;
    /* the mortar: a kick of light and dust at the tube */
    if (!sh.child) {
      const c = lin(theme[0], _l0);
      flash(sh.x, sh.y + 0.6, sh.z, c, 7, 0.35, 0.2);
      for (let i = 0; i < 7; i++) {
        sphereDir(_d);
        spawn(sh.x, sh.y + 0.4, sh.z, _d[0] * 5, Math.abs(_d[1]) * 9 + 3, _d[2] * 5,
          c, 0.7, rr(0.25, 0.5), { drag: 3.2, grav: 1.4, bright: 1.6 });
      }
      boom(sh.x, sh.y, sh.z, 'launch', 1);
    }
    return sh;
  }

  function breakShell(sh) {
    if (sh.type === 'multibreak') {
      /* the parent throws comets; each one breaks on its own fuse */
      const c = lin(sh.colA, _l0);
      flash(sh.x, sh.y, sh.z, c, 22 * sh.scale, 0.5, 0.34);
      addLight(c, 0.26 * sh.scale);
      boom(sh.x, sh.y, sh.z, 'boom', 0.8 * sh.scale);
      const kids = Math.round(rr(5, 7));
      for (let i = 0; i < kids; i++) {
        sphereDir(_d);
        _d[1] = _d[1] * 0.6 + 0.25;
        const s = rr(11, 17);
        const kid = launch({
          pad: { x: sh.x, z: sh.z, y: sh.y }, child: true,
          type: pick(['peony', 'ring', 'crackle', 'willow']),
          theme: pick(THEMES), scale: 0.62,
        });
        if (!kid) break;
        kid.x = sh.x; kid.y = sh.y; kid.z = sh.z;
        kid.vx = _d[0] * s; kid.vy = _d[1] * s + 4; kid.vz = _d[2] * s;
        kid.fuse = rr(0.55, 0.85);
        kid.t = 0;
      }
      return;
    }
    burst(sh.x, sh.y, sh.z, sh.type, sh.colA, sh.colB, sh.scale);
  }

  /* ================================================================
     7. THE MINUTE. A director, not a loop: six movements, each with
        its own rate, its own type weighting and its own salvos,
        building to a finale that empties every pad at once.
     ================================================================ */
  /* `apex` is a pair of DISTANCE FRACTIONS, not metres — see apexFor. */
  const PHASES = [
    { a: 0.000, b: 0.055, g0: 0.78, g1: 0.54, t: ['peony', 'ring', 'peony'], apex: [0.19, 0.29], salvo: 0 },
    { a: 0.055, b: 0.300, g0: 0.54, g1: 0.34, t: ['peony', 'ring', 'willow', 'peony', 'crackle'], apex: [0.15, 0.27], salvo: 3.8 },
    { a: 0.300, b: 0.560, g0: 0.34, g1: 0.26, t: ['peony', 'ring', 'willow', 'palm', 'crackle', 'multibreak'], apex: [0.13, 0.26], salvo: 3.4 },
    { a: 0.560, b: 0.790, g0: 0.26, g1: 0.20, t: ['willow', 'multibreak', 'peony', 'palm', 'ring'], apex: [0.12, 0.25], salvo: 2.9 },
    { a: 0.790, b: 0.860, g0: 0.20, g1: 0.13, t: ['crackle', 'peony', 'ring', 'multibreak', 'willow'], apex: [0.11, 0.24], salvo: 2.1 },
    { a: 0.860, b: 1.000, g0: 0.12, g1: 0.08, t: ['peony', 'crackle', 'ring', 'palm', 'multibreak'], apex: [0.11, 0.28], salvo: 0 },
  ];

  let running = false;
  let showT = 0;             // seconds since the show began
  let showLen = 60;          // seconds of LAUNCHING
  let nextLaunch = 0;
  let nextSalvo = 0;
  let finaleFired = false;
  let launched = 0, bursts = 0, dropped = 0;
  let peakLive = 0;
  let forcedTail = 0;
  let sinceBurst = 0;      // seconds since anything last broke

  /* WHICH PAD FIRES NEXT.

     A show scattered evenly over a 970 m island is a show the player
     mostly cannot see: the lens covers about sixty degrees of the
     three hundred and sixty the pads occupy, and the first pass duly
     put nearly every shell off-frame. So most launches are DIRECTED —
     scored on how far in front of the camera the pad is and on
     whether it sits in the band that frames well (90–420 m) — and the
     rest are left completely free, because "the whole town" has to
     mean the districts behind him as well. */
  const _fwd = new THREE.Vector3();
  const _scored = [];
  function padsInView(want) {
    ctx.camera.getWorldPosition(_cam);
    ctx.camera.getWorldDirection(_fwd);
    const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
    const fx = _fwd.x / fl, fz = _fwd.z / fl;
    _scored.length = 0;
    for (const p of pads) {
      const dx = p.x - _cam.x, dz = p.z - _cam.z;
      const D = Math.hypot(dx, dz) || 1;
      const facing = (dx * fx + dz * fz) / D;          // 1 = dead ahead
      /* The frame is about eighty degrees wide, so "in front of the
         camera" is not good enough — half of the forward hemisphere is
         still off the edge of the screen. Anything past sixty-odd
         degrees off axis is dropped, and the weighting is squared so
         the shells cluster where the player is actually looking. */
      if (facing < 0.60) continue;
      /* the band that frames: near enough to be chunky, far enough to
         sit over the rooftops rather than on top of the player */
      /* MEASURED, NOT GUESSED. At t = 14 s of the show, 1964 of 2505
         live particles were inside the frustum and the frame still did
         not read as fireworks: the shells were breaking 250–350 m out,
         where a two-metre spark is four pixels. Pulling the sweet spot
         in to 90–200 m doubles everything on screen for nothing. */
      const band = smoothstep(45, 95, D) * (1 - smoothstep(210, 400, D));
      if (band < 0.15) continue;
      const w = (0.08 + 0.92 * facing * facing * facing) * band;
      /* cheap weighting: push a pad into the bag once per 0.14 of score */
      const n = 1 + Math.floor(w * 7);
      for (let i = 0; i < n; i++) _scored.push(p);
    }
    return _scored.length >= want ? _scored : pads;
  }

  /* A POINT THE CAMERA IS DEFINITELY LOOKING AT. The finale's giants
     used to break over the city's centre of mass, which is fine until
     the player is STANDING on the city's centre of mass — the opening
     spawn is 44 m from it — and the climax of the whole game happened
     fifty degrees above the top of his screen. */
  const _fp = new THREE.Vector3();
  function framePoint(dMin, dMax, spread) {
    ctx.camera.getWorldPosition(_cam);
    ctx.camera.getWorldDirection(_fwd);
    const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
    const a = Math.atan2(_fwd.x / fl, _fwd.z / fl) + rr(-spread, spread);
    const D = rr(dMin, dMax);
    const x = _cam.x + Math.sin(a) * D;
    const z = _cam.z + Math.cos(a) * D;
    const g = ctx.world?.heightAt ? ctx.world.heightAt(x, z) : 0;
    return _fp.set(x, Math.max(g + 30, _cam.y + D * rr(0.13, 0.26)), z);
  }

  function phaseAt(u) {
    for (const p of PHASES) if (u >= p.a && u < p.b) return p;
    return PHASES[PHASES.length - 1];
  }

  function director(dt) {
    const u = clamp(showT / showLen, 0, 1);
    const P = phaseAt(u);
    const k = clamp((u - P.a) / Math.max(P.b - P.a, 1e-4), 0, 1);

    /* THE FINALE — one beat, once, at 95.5 %: every pad at once, three
       giants over the city centre, and a fanfare. */
    /* A SHELL TAKES TWO SECONDS TO GET UP THERE. Fire the finale at
       88 % and its breaks land between 55 and 60 seconds — inside the
       minute the payload promised. Fired at 95 % (which is where this
       started) the whole barrage was still climbing when the show was
       nominally over, and the last thing the player saw was an empty
       sky full of rising trails. */
    if (u >= 0.860 && !finaleFired) {
      finaleFired = true;
      ctx.audio?.sfx?.('fanfare', { gain: 0.5 });
      ctx.audio?.sfx?.('bell.big', { gain: 0.34, delay: 0.15 });
      /* EVERY PAD ON THE ISLAND, but two in three of them chosen from
         the ones the player can see. The whole town is firing; the
         part of it in his frame is firing hardest. */
      const wave = Math.min(pads.length, tier === 'low' ? 18 : 34);
      const near = padsInView(4);
      const far = pads.slice().sort(() => rng() - 0.5);
      let tAcc = 0;
      for (let i = 0; i < wave; i++) {
        tAcc += rr(0.06, 0.19);
        const pad = rng() < 0.66 ? pick(near) : far[i % far.length];
        const at = tAcc;
        pending.push({
          t: at,
          fn: () => launch({
            pad, type: pick(['peony', 'ring', 'crackle', 'palm', 'willow']),
            theme: pick(THEMES), apex: apexFor(pad, 0.12, 0.30), scale: rr(0.9, 1.25),
          }),
        });
      }
      /* Three giants, in frame, one every three-quarters of a second. */
      for (let i = 0; i < 3; i++) {
        pending.push({
          t: 1.9 + i * 0.8,
          fn: () => {
            const p = framePoint(170, 300, 0.42);
            burst(p.x, p.y, p.z, i === 1 ? 'multibreak' : 'peony',
              pick(THEMES)[0], HUE.cream, 2.0);
          },
        });
      }
      /* and a last, enormous double break as the minute closes */
      pending.push({
        t: 4.6,
        fn: () => {
          const p = framePoint(190, 260, 0.16);
          burst(p.x, p.y, p.z, 'peony', HUE.cream, HUE.gold, 2.6);
          burst(p.x, p.y, p.z, 'ring', HUE.token, HUE.cream, 1.9);
        },
      });
      pending.push({
        t: 5.6,
        fn: () => {
          const p = framePoint(150, 230, 0.5);
          burst(p.x, p.y, p.z, 'willow', HUE.gold, HUE.cream, 2.4);
        },
      });
    }

    if (u >= 1) return;      // launching is over; the sky drains

    /* salvos: three or four shells of ONE colour from ONE side of the
       city, so a movement has punctuation and not just a rate */
    if (P.salvo > 0) {
      nextSalvo -= dt;
      if (nextSalvo <= 0) {
        nextSalvo = P.salvo * rr(0.85, 1.15);
        const theme = pick(THEMES);
        const type = pick(P.t);
        const set = padsInView(3);
        for (let i = 0; i < (tier === 'low' ? 3 : 5); i++) {
          pending.push({
            t: i * 0.09,
            fn: () => { const p = pick(set); launch({ pad: p, type, theme, apex: apexFor(p, P.apex[0], P.apex[1]) }); },
          });
        }
      }
    }

    /* THE METRONOME.

       A rate is not a rhythm. A shell spends a second and a half
       climbing before it breaks, so an average gap of four-tenths of
       a second still leaves holes where nothing is bursting at all —
       and a screenshot, or a player glancing up, lands in one of
       those holes about as often as not. This closes them: if nothing
       has broken for nine-tenths of a second, put one up now, aimed,
       on a short fuse. It raises the average rate barely at all and
       it is the difference between a rate and a show. */
    sinceBurst += dt;
    if (sinceBurst > 0.90) {
      /* negative, not zero: the shell it is putting up needs about a
         second and a third to get there, so the next metronome beat
         has to wait that long or it stacks three at once */
      sinceBurst = -0.35;
      const set = padsInView(3);
      const pad = pick(set);
      launch({
        pad, type: pick(P.t), theme: pick(THEMES),
        apex: apexFor(pad, P.apex[0], P.apex[1] * 0.85), scale: rr(0.9, 1.1),
      });
    }

    nextLaunch -= dt;
    if (nextLaunch <= 0) {
      nextLaunch = lerp(P.g0, P.g1, k) * rr(0.78, 1.22);
      /* Weighted toward pads the camera can actually see, but never
         only those: the brief is the WHOLE TOWN celebrating. */
      /* three in four directed at the frame, one in four anywhere on
         the island — the districts behind him are celebrating too */
      const set = rng() < 0.76 ? padsInView(4) : pads;
      const pad = pick(set);
      launch({
        pad, type: pick(P.t), theme: pick(THEMES),
        apex: apexFor(pad, P.apex[0], P.apex[1]),
        scale: rr(0.85, 1.12),
      });
    }
  }

  /* ================================================================
     8. Simulation
     ================================================================ */
  const attrPos = geo.getAttribute('position');
  const attrCol = geo.getAttribute('aCol');
  const attrSiz = geo.getAttribute('aSize');
  const attrKnd = geo.getAttribute('aKind');
  const _dbs = new THREE.Vector2();

  function step(dt) {
    /* --- wind: the whole frame moves in it (§2.3) --- */
    let wx = 0, wz = 0;
    if (ctx.wind?.vector) {
      ctx.wind.vector(0, 0, _w);
      wx = (_w.x || 0) * 0.55; wz = (_w.z || 0) * 0.55;
    }

    /* --- deferred beats --- */
    for (let i = pending.length - 1; i >= 0; i--) {
      pending[i].t -= dt;
      if (pending[i].t <= 0) {
        const f = pending[i].fn;
        pending.splice(i, 1);
        try { f(); } catch (e) { console.warn('[fireworks]', e); }
      }
    }

    /* --- shells --- */
    for (let i = shells.length - 1; i >= 0; i--) {
      const s = shells[i];
      s.t += dt;
      s.vy -= G_RISE * dt;
      s.vx += wx * dt * 0.35; s.vz += wz * dt * 0.35;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      /* the comet's tail: hot, short-lived sparks laid along the path */
      s.emit -= dt;
      if (s.emit <= 0 && live < CAP * 0.88) {
        s.emit = 0.018;
        const c = lin(s.colA, _l0);
        _lt[0] = lerp(c[0], 1, 0.55); _lt[1] = lerp(c[1], 1, 0.5); _lt[2] = lerp(c[2], 0.85, 0.45);
        spawn(s.x, s.y, s.z, s.vx * 0.10 + rr(-1.2, 1.2), s.vy * 0.06 + rr(-1, 1), s.vz * 0.10 + rr(-1.2, 1.2),
          _lt, 0.66 * (s.child ? 0.7 : 1), rr(0.26, 0.52),
          { drag: 2.4, grav: 0.55, tw: 0.8, bright: 2.0, flags: F_TWINKLE | F_TRAIL });
      }
      if (s.t >= s.fuse || s.vy <= 0) {
        breakShell(s);
        bursts++;
        if (!s.child) sinceBurst = 0;
        shells.splice(i, 1);
      }
    }

    /* --- sparks --- */
    let i = 0;
    while (i < live) {
      const f = flg[i];
      age[i] += dt;
      const a = age[i], L = lif[i];
      if (a >= L) { kill(i); continue; }
      const u = a / L;
      const o = i * 3;

      if (!(f & F_FLASH)) {
        const dg = drg[i];
        const k = 1 - dg * dt;
        vx[i] *= k; vz[i] *= k;
        vy[i] = vy[i] * k - 9.81 * grv[i] * dt;
        vx[i] += wx * dt * 0.9; vz[i] += wz * dt * 0.9;
        pos[o] += vx[i] * dt;
        pos[o + 1] += vy[i] * dt;
        pos[o + 2] += vz[i] * dt;

        /* trailing glitter, budget permitting */
        if ((f & F_GLITTER) && live < CAP * 0.9) {
          emt[i] -= dt;
          if (emt[i] <= 0) {
            emt[i] = 1 / Math.max(erate[i], 1);
            _lg[0] = gr[i]; _lg[1] = gg[i]; _lg[2] = gb[i];
            spawn(pos[o], pos[o + 1], pos[o + 2],
              vx[i] * 0.16 + rr(-0.9, 0.9), vy[i] * 0.1 + rr(-0.6, 0.6), vz[i] * 0.16 + rr(-0.9, 0.9),
              _lg, 0.44 * rr(0.7, 1.25), rr(0.35, 0.8),
              { drag: 2.2, grav: 0.85, tw: 1.6, bright: 1.9, flags: F_TWINKLE });
          }
        }
      }

      /* --- burn-down: white-hot -> its own colour -> ember --- */
      let b, sz;
      if (f & F_FLASH) {
        const e = (1 - u) * (1 - u);
        b = br0[i] * e;
        sz = s0[i] * (0.55 + 0.75 * u);
      } else {
        const hot = Math.exp(-u * (f & F_TRAIL ? 5.0 : 9.5));
        let fl = 1;
        if (f & F_TWINKLE) {
          const t = twk[i];
          fl = 1 + t * 0.85 * Math.sin(a * (24 + t * 26) + pha[i]);
          fl = clamp(fl, 0.12, 2.3);
        }
        const decay = (1 - u) ** 1.20;
        b = br0[i] * decay * (0.62 + 0.38 * fl) * (1 + hot * 0.85);
        sz = s0[i] * (0.40 + 0.60 * decay) * (1 + hot * 0.70);
        /* A LITTLE white at birth, not a lot. At 0.8 every shell in
           the show broke paper-white against a daylight sky and the
           ten colour themes may as well not have existed. */
        const h = hot * 0.42;
        col[o]     = lerp(cr[i], 1.0, h) * b;
        col[o + 1] = lerp(cg[i], 1.0, h) * b;
        col[o + 2] = lerp(cb[i], 1.0, h) * b;
        siz[i] = sz;
        i++;
        continue;
      }
      col[o] = cr[i] * b; col[o + 1] = cg[i] * b; col[o + 2] = cb[i] * b;
      siz[i] = sz;
      i++;
    }

    if (live > peakLive) peakLive = live;

    /* --- the light on the town decays --- */
    light.k = Math.max(0, light.k - dt * 2.6);

    /* --- upload --- */
    /* One full upload of three small arrays — 84 kB at the 3000-spark
       ceiling. A partial updateRange would be cheaper still, but this
       build of three never clears the range list, so they accumulate. */
    geo.setDrawRange(0, live);
    if (live > 0) {
      attrPos.needsUpdate = true;
      attrCol.needsUpdate = true;
      attrSiz.needsUpdate = true;
      attrKnd.needsUpdate = true;
    }

    /* --- point size in screen pixels, per frame (fov moves on a
           vista beat, so this cannot be cached) --- */
    ctx.renderer.getDrawingBufferSize(_dbs);
    const fov = (ctx.camera.fov || 50) * PI / 180;
    uni.uScale.value = _dbs.y / (2 * Math.tan(fov * 0.5));
    const fog = ctx.scene.fog;
    if (fog && fog.isFog) uni.uFog.value.set(fog.near, fog.far);
  }

  /* ================================================================
     9. Public
     ================================================================ */
  function start(o = {}) {
    /* ONE SHOW. A second 'city:tokenized' — or a handler that fires
       twice — is ignored unless it is explicitly forced. */
    if (running && !o.force) return false;
    if (running) stop();
    running = true;
    show(true);
    showT = 0;
    showLen = clamp((o.durationMs ?? 60000) / 1000, 4, 600);
    nextLaunch = 0.25;
    nextSalvo = 3.5;
    finaleFired = false;
    sinceBurst = 0;
    launched = 0; bursts = 0; dropped = 0; peakLive = 0;
    forcedTail = 0;
    /* SEEDED, NOT RANDOM. Two runs of the same show are the same show,
       which is what makes a screenshot of it comparable between
       builds (BUILD_BRIEF). Pass o.seed for a different one. */
    rng = ctx.makeRng ? ctx.makeRng(o.seed ?? 'wally.fireworks.show') : Math.random;

    /* A BRIEF VISTA BEAT, NOT A CUTSCENE. The rig eases up and back
       and turns toward the middle of town for a few seconds, then
       hands the lens straight back. He can walk the whole minute. */
    if (o.camera !== false && ctx.cam?.vista) {
      const y = (ctx.world?.heightAt?.(hub.x, hub.z) ?? 0) + 55;
      try { ctx.cam.vista(new THREE.Vector3(hub.x, y, hub.z), o.vista ?? 6.5); }
      catch (e) { /* the show does not depend on the camera */ }
    }
    ctx.bus?.emit?.('fireworks', { kind: 'start', durationMs: showLen * 1000 });
    return true;
  }

  function stop() {
    running = false;
    freeRun = false;
    show(false);
    shells.length = 0;
    pending.length = 0;
    live = 0;
    geo.setDrawRange(0, 0);
    light.k = 0;
    ctx.bus?.emit?.('fireworks', { kind: 'stop' });
    return true;
  }

  /* ONE BREAK, IN FRONT OF THE LENS, WITHOUT THE SHOW.
     This is how every number in TYPES was tuned: a single shell at a
     known distance, screenshotted and measured. It also runs the
     simulation on its own (`freeRun`) so the sparks actually fall. */
  const _fd = new THREE.Vector3();
  function testBurst(o = {}) {
    show(true);
    freeRun = true;
    ctx.camera.getWorldPosition(_cam);
    ctx.camera.getWorldDirection(_fd);
    const fl = Math.hypot(_fd.x, _fd.z) || 1;
    const D = o.dist ?? 140;
    const x = _cam.x + (_fd.x / fl) * D;
    const z = _cam.z + (_fd.z / fl) * D;
    const y = (ctx.world?.heightAt?.(x, z) ?? 0) + (o.height ?? D * 0.30);
    const th = o.theme || THEMES[Math.floor(rng() * THEMES.length)];
    const type = o.type || 'peony';
    if (type === 'multibreak') {
      breakShell({ x, y, z, type, colA: th[0], colB: th[1], scale: o.scale ?? 1.2 });
    } else {
      burst(x, y, z, type, th[0], th[1], o.scale ?? 1.2);
    }
    return { type, dist: D, at: [Math.round(x), Math.round(y), Math.round(z)], live };
  }

  let freeRun = false;

  function update(dt) {
    if (!running && !freeRun) return;
    if (!running && freeRun && !live && !shells.length && !pending.length) {
      freeRun = false; show(false); return;
    }
    if (!running) { sfxBudget = 3; step(clamp(dt, 0, 1 / 20)); return; }
    /* Never integrate a hitch: a 400 ms frame would teleport every
       spark and empty the pool in one step. */
    const d = clamp(dt, 0, 1 / 20);
    sfxBudget = 3;
    showT += d;
    director(d);
    step(d);
    /* The show is over when the last launch has been made AND the sky
       has actually emptied — never before. */
    if (showT > showLen && !shells.length && !pending.length && live === 0) {
      forcedTail += d;
      if (forcedTail > 0.2) {
        running = false;
        show(false);
        ctx.bus?.emit?.('fireworks', { kind: 'end' });
      }
    }
  }

  return {
    group: points,
    start, stop, update, testBurst,
    light,
    get running() { return running; },
    get elapsed() { return showT; },
    get duration() { return showLen; },
    stats: () => ({
      running, t: +showT.toFixed(2), of: showLen,
      live, cap: CAP, peak: peakLive, shells: shells.length,
      launched, bursts, dropped, pads: pads.length,
      density: +DENS.toFixed(2), tier,
    }),
    dispose() {
      stop();
      points.parent?.remove(points);
      flashPoints.parent?.remove(flashPoints);
      geo.dispose();
      mat.dispose();
      flashMat.dispose();
    },
  };
}
