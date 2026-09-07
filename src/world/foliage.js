/* ============================================================
   foliage.js — ctx.foliage. Grass, trees and undergrowth.

   Boot stage 5.5: straight after `world`, which owns the heightfield
   and hands us `foliageGroup` to hang everything off. We read the
   ground through ctx.world's queries and never touch the terrain.

   WHAT LIVES WHERE
     foliage.js   this file — the orchestrator. Ground sampling, the
                  exclusion field (clearArea), the shared shader patch
                  that every instanced plant in the game rides, the
                  chunk streamer, the public API and the debug cameras.
     grass.js     the blade field.
     trees.js     five sculpted species, placed by zone.
     scatter.js   bushes, flowers, reeds, rocks, litter and the leaf
                  drift that keeps §2.3 true in every frame.

   THE CHUNK STREAMER
   Everything that only reads at close range — blades, flowers,
   bushes, rocks, reeds — is generated per 32 m chunk on demand around
   the camera, one chunk per frame, and evicted behind. Each chunk's
   InstancedMesh carries its own bounding sphere, so three frustum-culls
   the field for free and a 110 m grass radius costs a dozen draw calls
   instead of ninety.

   THE SHADER PATCH (§2.3, and the thing players notice)
   ctx.mat's foliage/toon materials already carry the toon ramp, the
   shadow law, CSM, fog and the global wind. What they cannot know
   about is a blade of grass: that it must bend proportionally to its
   own height, thin out with distance instead of popping, and get out
   of Wally's way. So rather than write a second lighting model, we
   take the material ctx.mat built and splice four things into its
   vertex shader — and into its prepass twin, so depth and colour
   agree on where the blade is:

     aFolRank    per-instance 0..1. Instances are rank-SORTED, so the
                 first N of them are a uniform random subset of the
                 whole. Density falls off with distance by raising a
                 cutoff against this rank, continuously, per blade.
                 The CPU then sets mesh.count from the same formula
                 evaluated at the chunk's NEAREST corner, which is
                 exactly conservative: every instance it drops was
                 already scaled to zero. No pop, no wasted vertex.
     bend        windWave() from core/wind.js, scaled by height² and
                 by the instance's own scale.
     push        blades lean away from the player inside a 0.85 m
                 radius and spring back behind him.
     fade        the same rank cutoff reaching zero at grassDist, so
                 the field dissolves into the terrain's own green
                 rather than ending at a line.

   API — ctx.foliage
   ------------------------------------------------------------
     plantTree(kind, x, z)   'broadleaf'|'orchard'|'palm'|'pine'|'topiary'
     clearArea(x, z, r)      forbid planting; removes what is there
     density(v)              0..2 multiplier, rebuilds the field
     windResponse(v)         0..2 multiplier on every bend
     stats()                 instance/triangle counters
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { LAND, SKY } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';
import { createGrassLayer } from './grass.js';
import { createTrees } from './trees.js';
import { createScatter } from './scatter.js';

/* ============================================================
   The vertex-shader splice.

   ctx.mat builds hand-written ShaderMaterials, so this is string
   surgery on a known shape rather than a fragile onBeforeCompile.
   Both the forward material and its `ndMaterial` prepass twin carry
   the same TOON_WIND block; we anchor on the one that actually
   displaces (`<var>.xyz += windOffset(...)`) and never on the
   declaration block above it.
   ============================================================ */

const FOL_DECL = /* glsl */`
attribute float aFolRank;
uniform vec4  uFolLOD;      // x = full to, y = thin to, z = gone at, w = thin fraction
uniform float uFolBend;
uniform float uFolPush;
uniform float uFolFat;      // extra local-X width at the far end of the fade
uniform float uFolTall;     // extra local-Y height at the far end of the fade
uniform float uFolFlatY;    // weight on the vertical leg of the fade distance
uniform vec4  uFolPlayer;   // xyz = player, w = radius
uniform float uFolWindK;
uniform float uFolPx;       // pixels per world metre at one metre of depth
uniform float uFolMinPx;    // drop an instance below this projected height
uniform vec4  uFolAir;      // x = near-grade end, y/z = pale from/to, w = pale strength
uniform vec3  uFolAirNear;  // albedo multiplier AT the lens (linear)
uniform vec3  uFolAirFar;   // albedo the far end pales to (linear)
`;

const FOL_BODY = /* glsl */`
  {
    vec3  fBase = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
    float fSy   = length( instanceMatrix[ 1 ].xyz );
    float fH    = clamp( position.y, 0.0, 1.0 );
    /* HEIGHT IS NOT DISTANCE. A camera thirty metres above a lawn it
       is looking straight down at is thirty metres from it, and a fade
       keyed on the raw 3-D distance answers "too far, show nothing" —
       which is why every town lawn in the game came back bare from any
       elevated shot while the lawn filled half the frame. Weighting
       the vertical leg down costs nothing at the gameplay camera,
       which is two metres up, and is the whole fix for the ones that
       are not. */
    vec3  fDv   = cameraPosition - fBase;
    fDv.y      *= uFolFlatY;
    float fD    = length( fDv );

    /* FATTEN WITH DISTANCE. A blade is ~3 cm wide; past forty metres
       that is under a pixel, so half of them alias away to nothing and
       the field has to be kept dense purely to survive sampling. Widen
       the survivors instead — invisible as thickness at that range,
       and it buys back the coverage that lets the density cutoff drop
       to a twentieth. It also kills the shimmer that sub-pixel
       geometry produces when the camera moves. */
    if ( uFolFat > 0.0 ) {
      float fFat = uFolFat * smoothstep( uFolLOD.x, uFolLOD.y, fD );
      $WP.xyz += ( modelMatrix * instanceMatrix
                 * vec4( position.x * fFat, 0.0, 0.0, 0.0 ) ).xyz;
    }

    /* wind: quadratic in height so the root stays planted, scaled by
       the instance so a short blade does not swing as far as a tall
       one. Phase is the world position, which is what makes a gust
       cross the field as a sheet instead of blinking it all at once. */
    if ( uFolBend > 0.0 ) {
      float fW = windWave( fBase, dot( fBase.xz, vec2( 0.71, 0.43 ) ) );
      float fB = fW * fH * fH * fSy * uFolBend * uFolWindK;
      $WP.x += uWindDir.x * fB;
      $WP.z += uWindDir.y * fB;
      $WP.y -= abs( fB ) * 0.22;
    }

    /* THE PLAYER PARTS THE GRASS — HE DOES NOT MOW IT. The sink term
       here used to be 0.5 of the push, which against a 0.18 m blade
       buried the tip nearly 0.1 m: more than half the blade, under the
       ground plane, across the whole radius. The result was a bald
       crop-circle of flattened green around Wally in every gameplay
       frame, with nothing touching his feet — which destroys the one
       contact read the eye is guaranteed to check and makes him look
       pasted onto the terrain. 0.12 is a foreshortening term for a
       blade that is leaning, not a flattening one. */
    if ( uFolPush > 0.0 ) {
      vec3 fPd = fBase - uFolPlayer.xyz;
      fPd.y = 0.0;
      float fPl = length( fPd );
      float fPush = 1.0 - smoothstep( uFolPlayer.w * 0.30, uFolPlayer.w, fPl );
      if ( fPush > 0.001 ) {
        vec2 fDir = fPl > 1e-3 ? fPd.xz / fPl : vec2( 1.0, 0.0 );
        $WP.xz += fDir * ( fPush * fH * fH * fSy * uFolPush );
        $WP.y  -= fPush * fH * fSy * uFolPush * 0.12;
      }
    }

    /* distance thinning — see the header. Must stay bit-identical to
       allowedAt() on the CPU or chunks will pop at their band edges. */
    float fAllow = mix( 1.0, uFolLOD.w, smoothstep( uFolLOD.x, uFolLOD.y, fD ) )
                 * ( 1.0 - smoothstep( uFolLOD.y, uFolLOD.z, fD ) );
    float fKeep = 1.0 - smoothstep( fAllow - 0.20, fAllow, aFolRank );
    $WP.xyz = fBase + ( $WP.xyz - fBase ) * fKeep;

    /* ------------------------------------------------------------
       AERIAL PERSPECTIVE, IN THE ALBEDO.

       A field has a value range from your boots to the horizon, and
       ours had none: measured across the boot frame, the grass sat at
       V 78 % in the bottom 15 % of the canvas and V 78 % at the
       treeline, which is the definition of a slab. Two independent
       reviews called it "acid" and "nuclear" for exactly this reason —
       a saturated green with no depth grade reads as paint, not as
       ground.

       scene.fog cannot fix it. §2.4's haze starts at ~100 m and the
       blade field ENDS at 110, so fog touches the last five metres of
       it and nothing else. The grade therefore has to live where the
       grass is: here, per blade, off the same fD the LOD already
       computed, so it costs one smoothstep and no extra work at all.

       Two stages, because they are two different physical things:
         near  — grass at your feet is in its own shadow, seen through
                 no air at all, and is the DARKEST, most saturated
                 green in the frame. uFolAirNear is a multiplier, so it
                 deepens hue as well as dropping value.
         far   — grass at the far end is seen through fifty metres of
                 lit air, so it pales and desaturates toward §2.4's
                 #B8DEF0. That is a mix, not a multiply: air ADDS
                 light, it cannot be modelled by scaling albedo down.

       Left at zero it is a no-op, so trees and scatter keep whatever
       they had until they ask for it.
       ------------------------------------------------------------ */
    #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
      if ( uFolAir.x > 0.0 ) {
        vec3 aTint = mix( uFolAirNear, vec3( 1.0 ), smoothstep( 0.0, uFolAir.x, fD ) );
        float aFar = smoothstep( uFolAir.y, uFolAir.z, fD ) * uFolAir.w;
        vColor.rgb = mix( vColor.rgb * aTint, uFolAirFar, aFar );
      }
    #endif
  }
`;

function spliceVertex(src) {
  let didDecl = false;
  let out = src.replace('#include <common>', (m) => {
    didDecl = true;
    return m + '\n' + FOL_DECL;
  });
  if (!didDecl) out = FOL_DECL + out;

  let didBody = false;
  out = out.replace(/#ifdef TOON_WIND([\s\S]*?)#endif/g, (m, inner) => {
    if (didBody) return m;
    const hit = /(\w+)\.xyz \+= windOffset/.exec(inner);
    if (!hit) return m;
    didBody = true;
    return m + '\n' + FOL_BODY.replace(/\$WP/g, hit[1]);
  });
  return didBody ? out : null;
}

/** JS twin of the shader's thinning curve. */
function allowedAt(d, lod) {
  return lerp(1, lod.w, smoothstep(lod.x, lod.y, d)) * (1 - smoothstep(lod.y, lod.z, d));
}

/* ============================================================
   Seeded value noise — grove clumping, meadow clearings, tint drift.
   Math.random() is banned in world generation (BUILD_BRIEF).
   ============================================================ */
function makeNoise(seed) {
  const h = (i, j) => {
    let n = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((j | 0) ^ seed, 0xc2b2ae35);
    n ^= n >>> 13; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15;
    return (n >>> 0) / 4294967296;
  };
  const f = (t) => t * t * (3 - 2 * t);
  function n2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = f(x - ix), fy = f(y - iy);
    return lerp(lerp(h(ix, iy), h(ix + 1, iy), fx),
                lerp(h(ix, iy + 1), h(ix + 1, iy + 1), fx), fy);
  }
  function fbm(x, y, o = 3) {
    let s = 0, a = 1, n = 0, fr = 1;
    for (let i = 0; i < o; i++) { s += n2(x * fr, y * fr) * a; n += a; a *= 0.5; fr *= 2.03; }
    return s / n;
  }
  return { n2, fbm };
}

/* ============================================================ */
export async function init(ctx) {
  const t0 = performance.now();
  const W = ctx.world;
  if (!W || !W.foliageGroup) {
    console.warn('[foliage] ctx.world missing — nothing planted');
    return null;
  }

  const q = ctx.quality;
  /* THE TIER'S grassDist IS A CEILING FOR THE FADE, NOT A BUDGET.
     ultra asks for 150 m, and a 150 m disc of blades is ~90 000
     instances even after thinning — measured, that was 4.8 M
     triangles of grass and a 43 fps grove. 120 m is where the far
     edge still lands past anything the eye reads as "the end of the
     grass", and it costs a third as much. */
  const GRASS_DIST = Math.min(q.grassDist ?? 90, 110);
  /* CHUNK IS A FRAME-TIME KNOB, NOT A TIDINESS ONE. The streamer builds
     one chunk per frame, so a chunk is a hitch: at 32 m and the density
     the grass now runs at, one was 15 ms of placement — a dropped frame
     every time the camera crossed into new ground. At 20 m it is under
     six. Smaller chunks also tighten the LOD, which is evaluated at a
     chunk's nearest corner and therefore over-draws by roughly its own
     width; the extra draw calls are cheaper than that was. */
  const CHUNK = 20;
  const DENS = { value: clamp(q.grass ?? 1, 0, 3) };

  const root = new THREE.Group(); root.name = 'foliage';
  const chunkRoot = new THREE.Group(); chunkRoot.name = 'foliage.chunks';
  root.add(chunkRoot);
  W.foliageGroup.add(root);

  /* ------------------------------------------------------------
     1. The exclusion field.

     Every location in game/data.js owns a clearance circle and the
     city agent is dropping a building inside it right now. Nothing
     grows there. Discs are bucketed into a 64 m hash so a per-blade
     test is a handful of compares, not a scan of the whole city.
     ------------------------------------------------------------ */
  const discs = [];
  const HCELL = 64;
  const HPAD = 18;                       // widest clearance query we answer
  let hash = new Map();

  const hkey = (i, j) => i * 4096 + j;
  function indexDisc(k) {
    const d = discs[k];
    const r = d.r + HPAD;
    const i0 = Math.floor((d.x - r) / HCELL), i1 = Math.floor((d.x + r) / HCELL);
    const j0 = Math.floor((d.z - r) / HCELL), j1 = Math.floor((d.z + r) / HCELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = hkey(i, j);
        let a = hash.get(key);
        if (!a) hash.set(key, a = []);
        a.push(k);
      }
    }
  }
  function addDisc(x, z, r) { discs.push({ x, z, r }); indexDisc(discs.length - 1); }

  for (const l of W.locations) addDisc(l.world.x, l.world.z, l.radius + 3.5);

  /** Metres outside the nearest clearance circle, clamped to HPAD. */
  function clearance(x, z) {
    const a = hash.get(hkey(Math.floor(x / HCELL), Math.floor(z / HCELL)));
    if (!a) return HPAD;
    let best = HPAD;
    for (let i = 0; i < a.length; i++) {
      const d = discs[a[i]];
      /* sqrt, not Math.hypot. This runs once per TUFT — three
         thousand times per chunk — and V8's hypot carries an
         overflow-safe scaling pass we have no use for at island
         coordinates. */
      const dx = x - d.x, dz = z - d.z;
      const dd = Math.sqrt(dx * dx + dz * dz) - d.r;
      if (dd < best) best = dd;
      if (best < -HPAD) return -HPAD;
    }
    return best;
  }
  const blocked = (x, z, pad = 0) => clearance(x, z) < pad;

  /* ------------------------------------------------------------
     2. Ground sampling.
     ------------------------------------------------------------ */
  const noise = makeNoise(0x0f01a6e);
  const BEACH = W.beachWidth ?? 26;

  /** 0..1 "this is planted turf". Sea, sand, cliff and road are 0. */
  function turf(x, z) {
    const h = W.heightAt(x, z);
    if (h < 0.85) return 0;
    let a = smoothstep(BEACH * 0.42, BEACH * 1.05, W.shoreDistAt(x, z));
    if (a <= 0.001) return 0;
    a *= 1 - smoothstep(0.26, 0.58, W.slopeAt(x, z));
    if (a <= 0.001) return 0;
    a *= 1 - smoothstep(0.10, 0.40, W.pathAt(x, z));
    return a;
  }

  /** Grove/clearing mask — meadows read as meadows, groves as groves. */
  function clump(x, z, scale = 0.013, bias = 0) {
    return clamp((noise.fbm(x * scale + 17.3, z * scale - 41.7, 3) - 0.5) * 2.4 + 0.5 + bias, 0, 1);
  }

  const _gc = new THREE.Color();
  const groundColorAt = (x, z, out) => W.groundColorAt(x, z, out || _gc);

  /* ------------------------------------------------------------
     3. Shared material plumbing.
     ------------------------------------------------------------ */
  /* PARTING RADIUS. 1.35 m is wider than Wally is — it cleared a disc
     the eye reads as a crop circle rather than as footfall. 0.85 m is
     just past his stance, so the blades that move are the ones his
     legs are actually in. */
  const PART_R = 0.85;
  const uPlayer = { value: new THREE.Vector4(0, -9999, 0, PART_R) };
  const uWindK = { value: 1 };
  let playerLocked = false;

  /** Build the per-material uniform block for a patched layer. */
  function folUniforms({
    d1, d2, d3, frac = 0.14, bend = 0, push = 0, fat = 0, flatY = 1,
    air = null, airNear = 0xffffff, airFar = SKY.haze,
  }) {
    return {
      uFolLOD: { value: new THREE.Vector4(d1, d2, d3, frac) },
      uFolBend: { value: bend },
      uFolPush: { value: push },
      uFolFat: { value: fat },
      uFolFlatY: { value: flatY },
      /* x = the depth by which the near grade has fully lifted,
         y..z = the pale ramp, w = how far it is allowed to go.
         All zero -> the block compiles to a dead branch. */
      uFolAir: { value: new THREE.Vector4(...(air || [0, 0, 0, 0])) },
      uFolAirNear: { value: airNear.isColor ? airNear : lin(airNear) },
      uFolAirFar: { value: airFar.isColor ? airFar : lin(airFar) },
      uFolPlayer: uPlayer,
      uFolWindK: uWindK,
    };
  }

  /**
   * Splice the foliage vertex behaviour into a ctx.mat material and
   * its prepass twin. The depth twin is deliberately left alone: it
   * renders from the sun's camera, where `cameraPosition` means
   * something else, and nothing we patch here casts a shadow.
   */
  function patch(mat, uniforms) {
    let ok = false;
    for (const m of [mat, mat.userData?.ndMaterial]) {
      if (!m) continue;
      const v = spliceVertex(m.vertexShader);
      if (!v) continue;
      m.vertexShader = v;
      for (const k in uniforms) m.uniforms[k] = uniforms[k];
      m.needsUpdate = true;
      ok = true;
    }
    if (!ok) console.warn('[foliage] shader splice missed on', mat.name);
    return mat;
  }

  /** Two-sided plants must not flip their normal — see grass.js. */
  function noBackflip(mat) {
    for (const m of [mat, mat.userData?.ndMaterial]) {
      if (!m) continue;
      m.fragmentShader = m.fragmentShader.replace(
        /if \( ! gl_FrontFacing \) N = - N;/, '/* foliage: lit both sides */');
      m.needsUpdate = true;
    }
    return mat;
  }

  const lin = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  const mixHex = (a, b, t) => lin(a).lerp(lin(b), t);

  const env = {
    ctx, world: W, quality: q,
    CHUNK, GRASS_DIST, DENS, BEACH,
    turf, clump, blocked, clearance, groundColorAt, noise,
    patch, noBackflip, folUniforms, allowedAt, lin, mixHex,
    uPlayer, uWindK,
    rngFor: (name) => ctx.makeRng('wally.foliage.' + name),
  };

  /* ------------------------------------------------------------
     4. Layers.
     ------------------------------------------------------------ */
  const grass = createGrassLayer(ctx, env);
  const scatter = createScatter(ctx, env);
  const trees = createTrees(ctx, env);

  root.add(trees.group);
  if (scatter.group) root.add(scatter.group);

  /* Chunked layers, near-range first so the streamer builds what the
     camera is standing in before what it is looking at. */
  const layers = [grass, ...scatter.layers].filter(Boolean);

  /* ------------------------------------------------------------
     THE STREAMER IS A BUDGET, NOT A COUNTER.

     Measured at 1600x900 in the boot scene, foliage.update() ran at
     42.9 ms a frame and 99 % of it was this function calling
     grass.build(). Not the LOD pass — that is 0.06 ms for the whole
     ring — and not the wind, which lives in a uniform. Chunk
     construction, inside update(), unbudgeted.

     Two bugs, and they compounded:

       1. `warm` counted FRAMES, and while it was positive the
          streamer built SIX chunks per frame with no time limit. Six
          chunks at 8.4 ms each is 50 ms, which drops the frame rate
          to 20, which means the 90-frame warm window lasts four and a
          half SECONDS of wall clock instead of one and a half. The
          slower it made the frame, the longer it stayed on.
       2. Even at one chunk a frame, one chunk was 8.4 ms — three
          times the entire frame budget for a subsystem that is
          supposed to be invisible.

       So: (1) is now a wall-clock window with a millisecond budget on
       top of it, and (2) is fixed in grass.js, where a chunk build
       went from 8.4 ms to well under one by not shuffling a
       thirty-thousand-element array and not round-tripping a Matrix4
       per blade. What is left here is O(chunks) — thirty-six of them
       — plus at most one build per frame once the ring is full.
     ------------------------------------------------------------ */
  const chunks = new Map();
  const MAX_RANGE = Math.max(...layers.map((l) => l.range));
  const minRange = Math.min(...layers.map((l) => l.range));
  const EVICT = MAX_RANGE + CHUNK * 1.6;
  const _focus = new THREE.Vector3();
  const _cam = new THREE.Vector3();

  /* The build queue, as three parallel arrays reused for the life of
     the process. `{i, j, d}` objects were a hundred-odd allocations
     every frame for a list that is usually empty. */
  const qi = [], qj = [], qd = [];
  let qn = 0;
  const upI = [], upJ = [], upL = [];      // band upgrades: chunk + layer slot
  let upn = 0;

  /* MILLISECONDS, NOT CHUNKS. 1.4 ms leaves the whole subsystem inside
     a fifth of a 60 fps frame even while the ring is filling, and the
     "at least one" rule below means progress never stalls no matter
     how expensive a single chunk turns out to be. */
  const BUILD_MS = 1.2;
  const WARM_MS = 1.6;                    // the wider budget at boot
  const WARM_FOR = 3000;                  // ...for this many milliseconds
  let warmUntil = performance.now() + WARM_FOR;

  /* Rescanning 225 cells and hashing each one is cheap, but it is not
     free and it only changes when the focus crosses a chunk boundary
     or the map does. */
  let lastFi = 1e9, lastFj = 1e9, queueDirty = true;

  function ckey(i, j) { return i * 8192 + j; }

  /* STREAM AROUND THE CAMERA, NOT THE PLAYER. They are four metres
     apart in gameplay and four hundred during a cinematic or a debug
     pose, and it is the camera that decides what has to exist. Keying
     this to the player is why an orchard shot from a fly-to camera
     came back standing on bare terrain. */
  function focusPoint(out) {
    ctx.camera.getWorldPosition(out);
    const p = ctx.wally?.root?.position || ctx.phys?.player?.position;
    /* nudge toward the player so the ground he is standing on is
       always inside the ring even when the rig is pulled back */
    if (p && out.distanceTo(p) < CHUNK) out.lerp(p, 0.5);
    return out;
  }

  /** The distance the LOD is evaluated at for one chunk and one layer. */
  function layerDist(c, L) {
    const dxz = Math.max(0, Math.hypot(c.cx - _cam.x, c.cz - _cam.z) - CHUNK * 0.71);
    const dy = (_cam.y - c.cy) * (L.flatY ?? 1);
    return Math.sqrt(dxz * dxz + dy * dy);
  }

  /* THE TRIGGER AND THE BUILD MUST ASK THE SAME QUESTION. They did
     not: the upgrade test below subtracted a hysteresis margin and
     this line did not, so any chunk sitting within the margin of a
     band edge was asked for band 0, built at band 1, asked again next
     frame — one grass chunk rebuilt every frame, for ever, with the
     camera standing perfectly still. That treadmill was 2.0 ms a
     frame on its own. One constant, used in both places. */
  const BAND_HYST = 4;

  /* ------------------------------------------------------------
     THE STREAM INSTRUMENT. Not a counter of chunks — a ring of the
     MILLISECONDS each layer build actually took, keyed by layer name,
     plus the per-frame tail cost. "Did amortising work" is a question
     about a distribution's TAIL, and chunks-per-second cannot answer
     it. Reads through ctx.foliage.streamStats().
     ------------------------------------------------------------ */
  const LOGN = 512;
  const slog = [];                    // per-frame cost of the build tail
  const llog = new Map();             // layer name -> per-build costs
  function logLayer(name, ms) {
    let a = llog.get(name); if (!a) llog.set(name, a = []);
    a.push(ms); if (a.length > LOGN) a.shift();
  }
  function logFrame(ms) { slog.push(ms); if (slog.length > LOGN) slog.shift(); }
  const qOf = (a, p) => { if (!a.length) return 0; const v = a.slice().sort((x, y) => x - y); return +v[Math.min(v.length - 1, Math.max(0, Math.ceil(v.length * p) - 1))].toFixed(3); };

  function buildLayer(c, L, slot) {
    const _t = performance.now();
    const band = L.bandFor ? L.bandFor(layerDist(c, L) - BAND_HYST) : 0;
    const m = L.build(c.i, c.j, band);
    /* Keyed by BAND, not just by layer. grass.js builds five density
       bands off one call and they do not cost the same; a single
       "grass p50" is an average over a mixture and hides which band
       is the expensive one. That is the number the handoff to grass.js
       needs. */
    logLayer((L.name || 'layer') + '#' + band, performance.now() - _t);
    if (!m) return null;
    if (m.userData.band == null) m.userData.band = band;
    if (m.userData.built == null) m.userData.built = m.userData.total ?? m.count;
    if (slot >= 0) {
      chunkRoot.remove(c.meshes[slot]);
      L.release?.(c.meshes[slot]);
      c.meshes[slot].geometry.dispose();
      c.meshes[slot].dispose?.();
      c.meshes[slot] = m;
    } else {
      c.meshes.push(m);
      c.layers.push(L);
    }
    chunkRoot.add(m);
    return m;
  }

  /* ============================================================
     THE UNIT OF STREAMING IS A LAYER, NOT A CHUNK.

     THE BUG. buildChunk() built EVERY in-range layer of a chunk in one
     call — five of them near the camera (grass, detail, bush, rock,
     reed) — and the tail below exempted the first chunk of each frame
     from the budget outright ("always allow the first one: a budget
     that can refuse every chunk is a world that never grows any
     grass"). Those two together mean the millisecond budget is
     advisory: the true worst case is a whole five-layer chunk,
     whatever it costs, on top of a budget already spent. That is the
     1.1-3.3 ms excess a profile found on slow frames against a 0.1 ms
     median, and it is why the QUIET districts have the worse tail —
     Green Edge and Iron Hills are where the grass and scatter ranges
     are full of ground to build, while the busy street is already
     paved and its chunks are mostly empty.

     THE FIX, and it keeps the rule that motivated the exemption. A
     chunk is REGISTERED immediately (so rescanQueue never re-queues
     it) with its in-range layers in `todo`, and the tail builds ONE
     LAYER at a time, finishing half-built chunks before starting new
     ground. The "always allow one" exemption survives, but it is now
     one LAYER rather than five, so the amount by which a frame can
     overshoot its budget is bounded by the single most expensive layer
     instead of by the sum of them.

     AND IT DID NOT WORK. MEASURED, so that nobody spends this week
     again. tools/_fa-stream2.mjs, matched pairs with every chunk
     dropped before each trial so both rules stream the same ground
     from bare (390x844, tier high, limiter off, M1 Max / ANGLE Metal,
     headless Chrome, load average 12-24), ONE layer build, by band:

         grass#0  n 42  p50 4.7  p95 7.3  worst 14.9 ms
         grass#1  n  8  p50 4.3
         grass#2  n 17  p50 3.8
         grass#3  n 17  p50 2.8
         grass#4  n 11  p50 2.4  p95 3.3   <- the COARSEST band
         detail#0 n 30  p50 0.2   bush#0 0.0   rock#0 0.0   reed#0 0.1

     Two things follow and both are fatal to scheduling this here.
     ONE: grass is 4.7 ms of a ~5.0 ms chunk, so splitting a chunk into
     its five layers moves the atomic unit from 5.0 to 4.7 — 6 %, for a
     chunk that is four times over the 1.2 ms budget either way.
     TWO: the coarsest band, at a fifth of the density, still costs
     2.4 ms. Half of band 0 for a fifth of the blades means the bill is
     FIXED PER CHUNK, not per blade — so building coarse first and
     letting the upgrade path promote it cannot work either, and
     neither can any other reordering of whole builds.

     Measured end to end, 'layer' was WORSE: the deferred cheap layers
     put small work on more frames (Market Square foliage-tail p95
     0.1 -> 4.8) without moving the spike (worst 9.5 -> 13.7). So
     'chunk' — the rule that shipped — is what ships.

     THE FIX IS IN grass.js, WHICH THIS AGENT DOES NOT OWN: build()
     has to become resumable across frames, or its fixed per-chunk cost
     has to be found. Everything above is the evidence for that ask.

     THE REVERT SWITCH stays because it is what produced the numbers.
     'chunk' is the shipped rule, 'layer' the one that lost; both live
     here and WALLY.debug.foliageStreamMode() drives them on ONE page
     load, so the next agent can re-run the comparison instead of
     trusting this comment.
     ============================================================ */
  let streamMode = 'chunk';
  const building = [];              // chunks with layers still in `todo`

  function buildChunk(i, j, dist) {
    const cx = (i + 0.5) * CHUNK, cz = (j + 0.5) * CHUNK;
    const c = { i, j, cx, cz, cy: W.heightAt(cx, cz), meshes: [], layers: [], partial: false, dcam: dist, todo: null };
    ctx.camera.getWorldPosition(_cam);
    /* A layer only exists inside its own range. Building the flower
       and litter layer out to the grass radius made 88 chunks of
       petals for the 12 that could ever be seen. */
    if (streamMode === 'chunk') {
      for (const L of layers) {
        if (dist > L.range) { c.partial = true; continue; }
        buildLayer(c, L, -1);
      }
    } else {
      const todo = [];
      for (const L of layers) {
        if (dist > L.range) { c.partial = true; continue; }
        todo.push(L);
      }
      if (todo.length) { c.todo = todo; building.push(c); }
    }
    chunks.set(ckey(i, j), c);
    queueDirty = true;
    return c;
  }

  /* Build ONE layer of the oldest unfinished chunk. Returns true if it
     did work. Identity, not just the key, is compared: a chunk can be
     evicted and a NEW record built for the same (i,j) while a stale
     one is still sitting in `building`, and that stale record's meshes
     would otherwise be added to a scene graph nothing will ever
     dispose them from. */
  function advanceBuild() {
    while (building.length) {
      const c = building[0];
      if (!c.todo || !c.todo.length || chunks.get(ckey(c.i, c.j)) !== c) {
        building.shift(); c.todo = null; continue;
      }
      buildLayer(c, c.todo.shift(), -1);
      if (!c.todo.length) { c.todo = null; building.shift(); }
      return true;
    }
    return false;
  }

  function disposeChunk(c) {
    for (let k = 0; k < c.meshes.length; k++) {
      const m = c.meshes[k];
      chunkRoot.remove(m);
      c.layers[k].release?.(m);
      m.geometry.dispose();
      m.dispose?.();
    }
    chunks.delete(ckey(c.i, c.j));
    queueDirty = true;
  }

  const _kill = [];
  /* Its own list. clearArea() is called by the city agent from
     outside this module and must never be able to clobber the
     eviction list streamChunks() is halfway through. */
  const _kill2 = [];
  function dropChunksIn(x, z, r) {
    _kill2.length = 0;
    for (const c of chunks.values()) {
      const dx = Math.abs(c.cx - x) - CHUNK * 0.5;
      const dz = Math.abs(c.cz - z) - CHUNK * 0.5;
      if (Math.hypot(Math.max(0, dx), Math.max(0, dz)) <= r) _kill2.push(c);
    }
    for (const c of _kill2) disposeChunk(c);
    _kill2.length = 0;
  }

  function rescanQueue(fi, fj) {
    const span = Math.ceil(MAX_RANGE / CHUNK) + 1;
    qn = 0;
    for (let i = fi - span; i <= fi + span; i++) {
      for (let j = fj - span; j <= fj + span; j++) {
        const cx = (i + 0.5) * CHUNK, cz = (j + 0.5) * CHUNK;
        const d = Math.hypot(cx - _focus.x, cz - _focus.z) - CHUNK * 0.71;
        if (d > MAX_RANGE) continue;
        if (chunks.has(ckey(i, j))) continue;
        /* insertion sort on distance — the list is short and almost
           always nearly sorted, and it saves a comparator closure and
           an array of objects every frame */
        let k = qn++;
        while (k > 0 && qd[k - 1] > d) { qi[k] = qi[k - 1]; qj[k] = qj[k - 1]; qd[k] = qd[k - 1]; k--; }
        qi[k] = i; qj[k] = j; qd[k] = d;
      }
    }
    queueDirty = false;
  }

  /* ------------------------------------------------------------
     The per-frame pass. Everything here is O(chunks) — the LOD
     walk sets one integer per mesh — plus a strictly budgeted tail
     that builds new ground and upgrades chunks that have come close
     enough to deserve more blades than their band gave them.
     ------------------------------------------------------------ */
  function streamChunks() {
    const t0 = performance.now();
    focusPoint(_focus);
    ctx.camera.getWorldPosition(_cam);
    const fi = Math.floor(_focus.x / CHUNK), fj = Math.floor(_focus.z / CHUNK);
    if (fi !== lastFi || fj !== lastFj) { lastFi = fi; lastFj = fj; queueDirty = true; }

    /* ---- LOD, eviction and upgrade detection ---- */
    _kill.length = 0;
    upn = 0;
    for (const c of chunks.values()) {
      const d = Math.hypot(c.cx - _focus.x, c.cz - _focus.z) - CHUNK * 0.71;
      if (d > EVICT) { _kill.push(c); continue; }
      /* a chunk built while it was too far for a short-range layer has
         to be rebuilt once it comes into that layer's reach */
      if (c.partial && d < minRange) { _kill.push(c); continue; }
      c.dcam = d;
      for (let k = 0; k < c.meshes.length; k++) {
        const L = c.layers[k], m = c.meshes[k];
        /* 3-D, not plan distance: the shader thins on distance from
           the camera, and a camera 30 m up over a chunk is 30 m away
           from it however close it looks on the map. Per layer,
           because each one declares its own flatY and the CPU cutoff
           must agree with the shader's or chunks pop at the band
           edges. */
        const ld = layerDist(c, L);
        L.lod(m, ld);
        /* HYSTERESIS, OR THE BOUNDARY BECOMES A REBUILD TREADMILL. A
           chunk sitting exactly on a band edge would otherwise
           rebuild every time the camera breathed. Only ever upgrade
           (build MORE blades); a chunk that has drifted outward keeps
           what it has until eviction, because throwing detail away
           costs a build to save nothing. */
        if (L.bandFor && m.userData.band > L.bandFor(ld - BAND_HYST) && upn < 8) {
          upI[upn] = c; upJ[upn] = k; upL[upn] = L; upn++;
        }
      }
    }
    for (let k = 0; k < _kill.length; k++) disposeChunk(_kill[k]);
    _kill.length = 0;

    /* ---- the budgeted tail ---- */
    const now = performance.now();
    const budget = now < warmUntil ? WARM_MS : BUILD_MS;
    if (queueDirty) rescanQueue(fi, fj);
    const tBuild = performance.now();

    let made = 0;
    if (streamMode === 'chunk') {
      while (qn > 0) {
        /* Always allow the first one: a budget that can refuse every
           chunk is a world that never grows any grass. */
        if (made > 0 && performance.now() - t0 > budget) break;
        buildChunk(qi[0], qj[0], qd[0]);
        for (let k = 1; k < qn; k++) { qi[k - 1] = qi[k]; qj[k - 1] = qj[k]; qd[k - 1] = qd[k]; }
        qn--;
        made++;
      }
    } else {
      /* Finish what is half-built before starting more ground: a chunk
         with grass but no bushes reads as a field, a chunk with
         nothing reads as a bug, and leaving several chunks each
         missing a different layer is how you get both. */
      while (building.length) {
        if (made > 0 && performance.now() - t0 > budget) break;
        if (!advanceBuild()) break;
        made++;
      }
      while (qn > 0) {
        if (made > 0 && performance.now() - t0 > budget) break;
        buildChunk(qi[0], qj[0], qd[0]);
        for (let k = 1; k < qn; k++) { qi[k - 1] = qi[k]; qj[k - 1] = qj[k]; qd[k - 1] = qd[k]; }
        qn--;
        /* Its first layer NOW, so a registered chunk is never a bare
           one for even a single frame — this is the near-range layer,
           `layers` being ordered near-first. */
        advanceBuild();
        made++;
      }
    }
    /* Upgrades are strictly lower priority than new ground — bare
       terrain reads as a bug, a slightly thin chunk does not. */
    for (let k = 0; k < upn && performance.now() - t0 <= budget; k++) {
      buildLayer(upI[k], upL[k], upJ[k]);
    }
    upn = 0;
    logFrame(performance.now() - tBuild);
  }

  /* ------------------------------------------------------------
     6. Debug — cameras and counters.
     ------------------------------------------------------------ */
  const dbg = (window.WALLY && window.WALLY.debug) || {};
  const camState = { active: false, pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50 };

  function takeCamera(p, l, fov) {
    /* NEVER LET A DEBUG CAMERA SINK INTO THE HILL. The terrain is
       single-sided, so a camera one metre under it does not render
       black — it renders the far hillside's grass standing in an empty
       sky, which took an embarrassingly long time to recognise as
       "you are underground". */
    p.y = Math.max(p.y, W.heightAt(p.x, p.z) + 1.7);
    camState.active = true;
    camState.pos.copy(p); camState.look.copy(l); camState.fov = fov;
    ctx.cam?.override?.(camState.pos, camState.look, fov);
    ctx.bus.emit('cam:override', { owner: 'foliage.debug' });
    applyCamera();
    return { pos: p.toArray().map((v) => +v.toFixed(2)), look: l.toArray().map((v) => +v.toFixed(2)), fov };
  }
  function applyCamera() {
    if (!camState.active) return;
    const cam = ctx.camera;
    cam.position.copy(camState.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(camState.look);
    if (cam.isPerspectiveCamera) {
      cam.fov = camState.fov; cam.near = 0.18; cam.far = 4000;
      cam.updateProjectionMatrix();
    }
  }

  /** Warm the streamer around a point before a screenshot is taken.

      DELIBERATELY UNBUDGETED. This is the one path that is allowed to
      spend as long as it likes: it runs from a debug hook or a scene
      jump, off the frame loop, precisely so that the frame loop never
      has to. Everything it builds is one chunk the streamer will not
      have to build later. */
  function primeAt(x, z, ms = 900) {
    const fi = Math.floor(x / CHUNK), fj = Math.floor(z / CHUNK);
    const span = Math.ceil(MAX_RANGE / CHUNK) + 1;
    const want = [];
    for (let i = fi - span; i <= fi + span; i++) {
      for (let j = fj - span; j <= fj + span; j++) {
        const cx = (i + 0.5) * CHUNK, cz = (j + 0.5) * CHUNK;
        const d = Math.hypot(cx - x, cz - z);
        if (d - CHUNK * 0.71 > MAX_RANGE) continue;
        if (!chunks.has(ckey(i, j))) want.push({ i, j, d: d - CHUNK * 0.71 });
      }
    }
    want.sort((a, b) => a.d - b.d);
    ctx.camera.getWorldPosition(_cam);
    const t0 = performance.now();
    for (const c of want) {
      const ch = buildChunk(c.i, c.j, c.d);
      /* THIS PATH MUST STAY ATOMIC. streamMode 'layer' defers a
         chunk's layers to the frame tail, which is exactly right in
         update() and exactly wrong here: primeAt exists to have the
         world already built before the first gameplay frame, and a
         hundred and twenty chunks registered with their layers still
         in `todo` would hand the streamer the whole job back one
         layer at a time. Finish each one where it is asked for. */
      while (ch.todo && ch.todo.length) buildLayer(ch, ch.todo.shift(), -1);
      if (ch.todo) { ch.todo = null; const k = building.indexOf(ch); if (k >= 0) building.splice(k, 1); }
      if (performance.now() - t0 > ms) break;
    }
    warmUntil = performance.now() + WARM_FOR;
  }

  /* A hand-picked spot per preset, resolved against the live terrain
     so these keep working when the heightfield changes under us. */
  function findSpot(pred, cx, cz, rMax = 150) {
    const rng = ctx.makeRng('foliage.spot.' + cx + ',' + cz);
    let best = null, bs = -1;
    for (let k = 0; k < 900; k++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * rMax;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const s = pred(x, z);
      if (s > bs) { bs = s; best = { x, z, s }; }
      if (bs > 0.985) break;
    }
    return best;
  }

  const _p = new THREE.Vector3(), _l = new THREE.Vector3();

  dbg.foliageCam = (preset = 'field') => {
    const G = W.zones.greenedge.world;

    if (preset === 'grove') {
      const v = trees.bestView(48, 23);
      primeAt(v.px, v.pz);
      const y = W.heightAt(v.px, v.pz);
      _p.set(v.px, y + 3.2, v.pz);
      _l.set(v.tx, W.heightAt(v.tx, v.tz) + 5.4, v.tz);
      return { preset, ...takeCamera(_p, _l, 48), trees: Math.round(v.n) };
    }

    if (preset === 'closeup') {
      const s = findSpot((x, z) => turf(x, z) * (blocked(x, z, 6) ? 0 : 1)
        * (1 - smoothstep(0.06, 0.22, W.slopeAt(x, z))), G.x + 40, G.z + 70, 90);
      const y = W.heightAt(s.x, s.z);
      primeAt(s.x, s.z);
      /* Stand Wally in it so the parting is real and not a uniform
         poked in for the photograph. */
      ctx.phys?.player?.teleport?.(new THREE.Vector3(s.x + 0.4, y + 0.1, s.z - 1.4));
      _p.set(s.x - 2.6, y + 1.05, s.z + 2.5);
      _l.set(s.x + 0.35, y + 0.75, s.z - 1.2);
      return { preset, ...takeCamera(_p, _l, 44) };
    }

    /* field — low, wide and reverent (§2.5). Composed rather than
       found: stand back from the thickest grove on the island, on the
       inland side, and look out over it toward the coast, so the frame
       reads grass / trees / sea / sky from the bottom up. */
    /* trees.js exposes bestView(), not a grove centroid — its target
       point is the middle of the thickest wood it could frame, which
       is the same thing this preset used to ask densestGrove() for. */
    const bv = trees.bestView(52, 24);
    const t = { x: bv.tx, z: bv.tz };
    const outLen = Math.hypot(t.x, t.z) || 1;
    const ox = t.x / outLen, oz = t.z / outLen;
    const sx = t.x - ox * 62, sz = t.z - oz * 62;
    const s = findSpot((x, z) => turf(x, z) * (blocked(x, z, 16) ? 0 : 1)
      * (1 - smoothstep(0.05, 0.22, W.slopeAt(x, z))), sx, sz, 26);
    const y = W.heightAt(s.x, s.z);
    primeAt(s.x, s.z);
    _p.set(s.x, y + 2.45, s.z);
    _l.set(s.x + ox * 150, y + 14, s.z + oz * 150);
    return { preset, ...takeCamera(_p, _l, 52) };
  };

  dbg.foliageRelease = () => {
    camState.active = false;
    ctx.cam?.releaseOverride?.();
    ctx.cam?.resume?.();
    ctx.bus.emit('cam:release', { owner: 'foliage.debug' });
  };

  dbg.foliageStats = () => api.stats();
  /* The build-tail distribution, and the switch between the shipped
     chunk-atomic rule and the layer-at-a-time one. Driven by
     tools/_fa-stream.mjs on one page load. */
  dbg.foliageStream = () => api.streamStats();
  dbg.foliageStreamMode = (m) => api.streamMode(m);
  /* DROP EVERY CHUNK, so the next trial streams the SAME ground from
     bare rather than finding the previous trial's work already done.
     Without this an A/B walks identical ground twice and the second
     run builds nothing at all — which reads as a fix and is an
     artifact of the order. Debug only; the streamer refills it. */
  dbg.foliageDrop = () => {
    const n = chunks.size;
    for (const c of [...chunks.values()]) disposeChunk(c);
    building.length = 0;
    slog.length = 0; llog.clear();
    warmUntil = 0;              // no warm budget: measure the shipping one
    return { dropped: n };
  };
  dbg.foliageChunks = () => [...chunks.values()]
    .map((c) => [Math.round(c.dcam ?? -1), c.meshes[0]?.count | 0, c.meshes[0]?.userData.total | 0])
    .sort((a, b) => a[0] - b[0]);
  dbg.foliageDensity = (v) => api.density(v);
  /* grassLOD(fullTo, thinTo, floor, fat) — metres, metres, 0..1, 0..3.
     Tunes the blade falloff live so it can be judged against a frame
     and a frame time in the same session. */
  dbg.grassLOD = (d1, d2, frac, fat) => grass.setLOD(d1, d2, frac, fat);
  dbg.foliageWind = (v) => api.windResponse(v);
  if (window.WALLY) window.WALLY.debug = dbg;

  /* ------------------------------------------------------------
     7. ctx.foliage
     ------------------------------------------------------------ */
  const _pp = new THREE.Vector3();
  let primed = false;

  const api = {
    root, chunkRoot,
    trees, grass, scatter,

    /** Plant one tree. Returns false if the spot is taken. */
    plantTree(kind, x, z) { return trees.plant(kind, x, z); },

    /** Forbid planting inside a disc, and remove whatever is already
        in it. The city agent calls this for every building it lands. */
    clearArea(x, z, r) {
      addDisc(x, z, r);
      trees.clear(x, z, r);
      dropChunksIn(x, z, r);
      return true;
    },

    /** Global density multiplier. Rebuilds the streamed field. */
    density(v) {
      DENS.value = clamp(v, 0, 3);
      for (const c of [...chunks.values()]) disposeChunk(c);
      warmUntil = performance.now() + WARM_FOR;
      return DENS.value;
    },

    /** Global wind-response multiplier on every patched material. */
    windResponse(v) {
      uWindK.value = clamp(v, 0, 3);
      trees.setWind(uWindK.value);
      return uWindK.value;
    },

    /** Ask the streamer to fill in around a point right now. */
    prime(x, z) { primeAt(x, z); },

    /* THE TAIL, NOT THE MEAN. `frame` is the distribution of what the
       build tail cost per frame; `layers` is the distribution of a
       single layer build, per layer. Amortising moves the first and
       leaves the second alone, which is the whole point and is
       invisible to any average of the two. */
    streamStats() {
      const out = { mode: streamMode, chunks: chunks.size, unfinished: building.length,
        budgetMs: BUILD_MS, frames: slog.length,
        frame: { p50: qOf(slog, 0.5), p95: qOf(slog, 0.95), p99: qOf(slog, 0.99), worst: qOf(slog, 1) },
        layers: {} };
      for (const [k, a] of llog) out.layers[k] = { n: a.length, p50: qOf(a, 0.5), p95: qOf(a, 0.95), worst: qOf(a, 1) };
      return out;
    },
    /** THE REVERT SWITCH — 'chunk' is the shipped rule, 'layer' the new
        one. Clears the instrument so the two are never mixed. */
    streamMode(m) {
      if (m === 'chunk' || m === 'layer') {
        if (m !== streamMode) { slog.length = 0; llog.clear(); }
        streamMode = m;
      }
      return streamMode;
    },

    stats() {
      let inst = 0, tri = 0, meshes = 0;
      for (const c of chunks.values()) {
        for (const m of c.meshes) {
          meshes++;
          inst += m.count;
          tri += m.count * (m.geometry.index ? m.geometry.index.count : 0) / 3;
        }
      }
      const t = trees.stats();
      return {
        chunks: chunks.size, chunkMeshes: meshes,
        chunkInstances: inst, chunkTris: Math.round(tri),
        trees: t.total, treesDrawn: t.drawn, treeTris: t.tris,
        density: +DENS.value.toFixed(2), wind: +uWindK.value.toFixed(2),
        grassDist: GRASS_DIST, buildMs: Math.round(buildMs),
      };
    },

    update(dt, elapsed) {
      /* BUILD THE WORLD BEFORE YOU START RENDERING IT.

         A hundred and twenty chunks have to exist before the first
         gameplay frame, and there are only two places to put that
         work: spread across two seconds of frames at one chunk each,
         or once, here, while the boot overlay is still fading. The
         first is what shipped, and it is why the streamer had a
         "warm" mode at all — a mode whose entire purpose was to break
         its own frame budget. This is a fifth of a second, once, on
         the frame after the camera rig has taken its position, and it
         is the difference between the streamer running at 3 ms for
         two seconds and never running above a tenth of one. */
      if (!primed) {
        primed = true;
        focusPoint(_focus);
        primeAt(_focus.x, _focus.z, 220);
      }
      /* Follow the player for the parting. Kept in a uniform rather
         than a per-blade CPU pass — 20 000 blades, one vec4. */
      if (!playerLocked) {
        const p = ctx.wally?.root?.position || ctx.phys?.player?.position;
        if (p) uPlayer.value.set(p.x, p.y, p.z, PART_R);
      }
      /* Trunks are solid, canopies are not (trees.js TRUNK_SOLID). The
         trees were planted in the world stage, before ctx.phys existed,
         so the boxes are handed over on the first frame that has one.
         Idempotent — it early-returns for the rest of the game. */
      trees.wirePhysics();
      streamChunks();
      trees.update(dt, elapsed);
      scatter.update(dt, elapsed);
    },

    lateUpdate() { applyCamera(); },

    dispose() {
      for (const c of [...chunks.values()]) disposeChunk(c);
      trees.dispose();
      scatter.dispose();
      grass.dispose();
      W.foliageGroup.remove(root);
    },
  };

  const buildMs = performance.now() - t0;
  console.log(`[foliage] ${trees.stats().total} trees, ${layers.length} streamed layers, ` +
    `grass to ${GRASS_DIST} m — ${Math.round(buildMs)} ms`);

  return api;
}
