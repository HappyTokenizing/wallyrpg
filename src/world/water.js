/* ============================================================
   water.js — ctx.water. The sea, which in a Wind Waker game is a
   main character and not a backdrop.

   ART_DIRECTION §5.4, implemented in one forward material:

     - BANDED depth colour, #57C6D8 shallow to #1B6FA8 deep, five
       discrete steps with a one-pixel roll-off. Never a gradient.
       The bands are read from a baked seabed depth field and are
       displaced by the swell, so they breathe with the waves instead
       of sitting on the surface like paint.
     - Gerstner displacement, four waves, direction and amplitude
       driven by ctx.wind. Same field in JS (heightAt) so buoyancy,
       the controller and the shader can never disagree.
     - Banded 3-step specular, and stylised sparkle glints that pop on
       the crests and are pushed over the bloom threshold on purpose.
     - HARD-EDGED OPAQUE white foam (#F4FBFF): a shoreline band that
       follows the terrain intersection exactly and runs in and out
       with the swell, plus a ring around everything touching the
       water. Nothing here uses a soft alpha ramp.
     - Scrolling caustic bands in the shallows; wet sand above the
       waterline (foam.js).
     - A cheap stylised sky + island-silhouette reflection at high
       tiers, fresnel-weighted and banded. Never a mirror.

   THE SEABED FIELD
   Everything that makes the sea read as a *place* — the bands, the
   foam line, the caustics, the wave damping — is a function of water
   depth, so depth is baked once into a texture at boot from
   ctx.world.heightAt(). Reading the depth buffer instead would cost a
   copy, break on the low tier (which has no prepass) and give us
   nothing on the CPU side, where the same field has to answer
   heightAt() for physics.

   The terrain agent builds in parallel, so if ctx.world has no
   heightAt yet we fall back to an analytic island derived from
   WORLD.islandRadiusX/Z and WORLD.shoreSDF (game/data.js) and put up
   a stand-in landmass so the sea still has a coast to break on. The
   stand-in removes itself the moment real terrain exists.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { SEA, SKY, LAND, SHADOW } from '../core/palette.js';
import { clamp, smoothstep, damp } from '../core/contracts.js';
import { WORLD } from '../game/data.js';
import { createRipples } from './ripples.js';
import { createFoam } from './foam.js';

/* ------------------------------------------------------------------
   The wave set. Amplitudes are metres at full wind; `sp` scales the
   deep-water dispersion w = sqrt(g k) down to something a stylised
   sea can carry without looking like a storm. `fade` is the distance
   in metres over which the wave is flattened out, chosen per
   wavelength so a wave is dropped before the ocean tessellation stops
   being able to sample it — this is what keeps the horizon from
   fizzing.
   ------------------------------------------------------------------ */
const WAVES = [
  { len: 33.0, amp: 0.400, q: 0.72, ang: 0.00, sp: 0.62, fade: [520, 1400] },
  { len: 17.0, amp: 0.205, q: 0.62, ang: 0.66, sp: 0.66, fade: [220, 620] },
  { len: 8.40, amp: 0.105, q: 0.55, ang: -1.02, sp: 0.72, fade: [95, 260] },
  { len: 3.90, amp: 0.042, q: 0.45, ang: 1.90, sp: 0.80, fade: [34, 105] },
];
const NW = WAVES.length;
const G = 9.81;

/* Ocean disc tessellation per tier. Radii grow geometrically, so the
   metre-per-vertex budget is spent where the camera is. */
const DISC = {
  low:   { rings: 60, sectors: 112 },
  med:   { rings: 88, sectors: 152 },
  high:  { rings: 120, sectors: 200 },
  ultra: { rings: 132, sectors: 224 },
};
const DISC_MIN = 0.45;
const DISC_MAX = 12000;

/* The baked seabed field covers the island plus a wide margin; past
   the edge the texture clamps, which is deep water everywhere. */
const SEABED = { x0: -620, z0: -520, w: 1240, h: 1040 };

const tierName = (n) => String(n || 'high').replace(/\(.*/, '');

/* ==================================================================
   Analytic stand-in island — used for the seabed field when the
   terrain module has not published heightAt() yet, and to build the
   stand-in landmass. Deterministic: no Math.random anywhere.
   ================================================================== */
const RX = WORLD.islandRadiusX;
const RZ = WORLD.islandRadiusZ;

function shoreRadius(dx, dz) {
  /* Ellipse radius along a unit direction, wobbled so the coast is a
     coast and not a drawing-compass ellipse. */
  const re = 1 / Math.hypot(dx / RX, dz / RZ);
  const th = Math.atan2(dz, dx);
  const wob = Math.sin(th * 3 + 0.7) * 9.0
            + Math.sin(th * 7 - 1.9) * 5.5
            + Math.sin(th * 13 + 2.4) * 2.6;
  return re + wob;
}

function hills(x, z) {
  const h = Math.sin(x * 0.0071 + 1.3) * Math.cos(z * 0.0083 - 0.6) * 13
          + Math.sin(x * 0.0163 - 2.1) * Math.cos(z * 0.0141 + 1.9) * 6
          + Math.sin(x * 0.0327 + 0.4) * Math.cos(z * 0.0291 - 1.2) * 2.2;
  return h + 14;
}

function fallbackGround(x, z) {
  const r = Math.hypot(x, z);
  if (r < 1e-3) return hills(0, 0);
  const dx = x / r, dz = z / r;
  const t = shoreRadius(dx, dz) - r;      // metres inland of the coast
  if (t <= 0) {
    const s = -t;
    return -(0.16 * Math.pow(s, 1.15) / (1 + s / 220));
  }
  const beach = WORLD.beachWidth;
  let y = t < beach
    ? 1.05 * Math.pow(t / beach, 1.35)
    : 1.05 + 15 * (1 - Math.exp(-(t - beach) / 130));
  y += hills(x, z) * smoothstep(0, 90, t) * 0.6;
  return y;
}

/* ================================================================== */

export async function init(ctx) {
  const T = ctx.THREE || THREE;
  const srgb = (hex) => new T.Color().setHex(hex, T.SRGBColorSpace);
  const q = ctx.quality || {};
  const tier = tierName(q.name);
  const level = WORLD.seaLevel ?? 0;

  const group = new T.Group();
  group.name = 'water';
  ctx.scene.add(group);

  /* ================================================================
     1. THE SEABED FIELD
     ================================================================ */
  const worldHeight = (x, z) => {
    const w = ctx.world;
    const f = w && (w.heightAt || w.groundAt || w.terrainAt);
    if (typeof f === 'function') {
      const v = f.call(w, x, z);
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (v && Number.isFinite(v.y)) return v.y;
    }
    return null;
  };
  const hasTerrain = worldHeight(0, 0) !== null;
  const groundSample = hasTerrain
    ? (x, z) => { const v = worldHeight(x, z); return v === null ? fallbackGround(x, z) : v; }
    : fallbackGround;

  /* Size the bake to a time budget rather than a fixed number: a real
     heightfield query can be a hundred times the cost of the analytic
     stand-in, and a two-second hitch at boot is not acceptable. */
  let SB = 1024;
  {
    const t0 = performance.now();
    for (let i = 0; i < 1500; i++) groundSample((i % 60) * 9 - 300, ((i / 60) | 0) * 9 - 200);
    const per = (performance.now() - t0) / 1500;
    while (SB > 256 && per * SB * SB > 240) SB >>= 1;
    if (tier === 'low' && SB > 512) SB = 512;
  }

  const sbDepth = new Float32Array(SB * SB);      // sea level - ground, metres
  const sbData = new Uint8Array(SB * SB * 4);

  function bakeSeabed() {
    const sx = SEABED.w / (SB - 1), sz = SEABED.h / (SB - 1);
    for (let j = 0; j < SB; j++) {
      const z = SEABED.z0 + j * sz;
      for (let i = 0; i < SB; i++) {
        const x = SEABED.x0 + i * sx;
        sbDepth[j * SB + i] = level - groundSample(x, z);
      }
    }
    /* R: fine near-surface range [-2, +6] m, 0.031 m per step — this
       is the one the foam line and the first two colour bands read.
       G: coarse range [-6, +54] m for the deep bands.
       B: |grad depth| over a 0..3 m/m range. The foam band is sized
       in metres ALONG THE GROUND and converted to a depth threshold
       with this, which is the only way one number gives a wide sheet
       of surf on a shallow beach and a thin lip against a rock. */
    for (let j = 0; j < SB; j++) {
      for (let i = 0; i < SB; i++) {
        const k = j * SB + i;
        const d = sbDepth[k];
        const dxp = sbDepth[j * SB + Math.min(SB - 1, i + 1)];
        const dxm = sbDepth[j * SB + Math.max(0, i - 1)];
        const dzp = sbDepth[Math.min(SB - 1, j + 1) * SB + i];
        const dzm = sbDepth[Math.max(0, j - 1) * SB + i];
        const gx = (dxp - dxm) / (2 * sx), gz = (dzp - dzm) / (2 * sz);
        const slope = Math.hypot(gx, gz);
        sbData[k * 4]     = clamp((d + 2) / 8, 0, 1) * 255;
        sbData[k * 4 + 1] = clamp((d + 6) / 60, 0, 1) * 255;
        sbData[k * 4 + 2] = clamp(slope / 3, 0, 1) * 255;
        sbData[k * 4 + 3] = 255;
      }
    }
  }
  bakeSeabed();

  const tSeabed = new T.DataTexture(sbData, SB, SB, T.RGBAFormat, T.UnsignedByteType);
  tSeabed.name = 'water.seabed';
  tSeabed.minFilter = T.LinearFilter;
  tSeabed.magFilter = T.LinearFilter;
  tSeabed.wrapS = tSeabed.wrapT = T.ClampToEdgeWrapping;
  tSeabed.generateMipmaps = false;
  tSeabed.needsUpdate = true;

  /** Bilinear CPU read of the same field the shader samples. */
  function depthAt(x, z) {
    const u = (x - SEABED.x0) / SEABED.w * (SB - 1);
    const v = (z - SEABED.z0) / SEABED.h * (SB - 1);
    const i0 = clamp(Math.floor(u), 0, SB - 1), j0 = clamp(Math.floor(v), 0, SB - 1);
    const i1 = Math.min(i0 + 1, SB - 1), j1 = Math.min(j0 + 1, SB - 1);
    const fu = clamp(u - i0, 0, 1), fv = clamp(v - j0, 0, 1);
    const a = sbDepth[j0 * SB + i0], b = sbDepth[j0 * SB + i1];
    const c = sbDepth[j1 * SB + i0], d = sbDepth[j1 * SB + i1];
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  }

  /* ================================================================
     2. WAVE STATE — one definition, two evaluators
     ================================================================ */
  const waveDir = [], waveKW = [], waveAQ = [], waveFade = [];
  for (let i = 0; i < NW; i++) {
    waveDir.push(new T.Vector2(1, 0));
    waveKW.push(new T.Vector2(2 * Math.PI / WAVES[i].len,
                              Math.sqrt(G * 2 * Math.PI / WAVES[i].len) * WAVES[i].sp));
    waveAQ.push(new T.Vector2(WAVES[i].amp, WAVES[i].q));
    waveFade.push(new T.Vector2(WAVES[i].fade[0], WAVES[i].fade[1]));
  }
  /* Flattened to plain arrays for the shader (vec2[] uniforms) and
     kept as JS numbers for heightAt(), which runs per body per step. */
  const jsDir = new Float32Array(NW * 2);
  const jsKW = new Float32Array(NW * 2);
  const jsAQ = new Float32Array(NW * 2);

  let windAngle = 0.6;
  let windStr = 0.5;

  function refreshWaves() {
    const w = ctx.wind;
    if (w) {
      const d = w.uniforms.uWindDir.value;
      windAngle = Math.atan2(d.y, d.x);
      windStr = clamp(w.uniforms.uWindStrength.value + w.uniforms.uWindGust.value * 0.7, 0, 1.4);
    }
    const scale = 0.40 + 0.60 * clamp(windStr / 0.85, 0, 1.35);
    for (let i = 0; i < NW; i++) {
      const a = windAngle + WAVES[i].ang;
      waveDir[i].set(Math.cos(a), Math.sin(a));
      waveAQ[i].x = WAVES[i].amp * scale;
      jsDir[i * 2] = waveDir[i].x; jsDir[i * 2 + 1] = waveDir[i].y;
      jsKW[i * 2] = waveKW[i].x; jsKW[i * 2 + 1] = waveKW[i].y;
      jsAQ[i * 2] = waveAQ[i].x; jsAQ[i * 2 + 1] = waveAQ[i].y;
    }
  }
  refreshWaves();

  /** Shore damping: a wave cannot be taller than the water it is in. */
  const shoreDamp = (depth) => smoothstep(0.05, 2.6, depth);

  /**
   * Surface height at a world point. `t` defaults to now.
   * Mirrors wGerstnerY() in the shader exactly; the horizontal part of
   * the Gerstner displacement is deliberately not inverted here — at
   * our steepness it moves the answer by under 2 cm and buoyancy would
   * pay for the iteration every step.
   */
  function heightAt(x, z, t) {
    const time = t === undefined ? ctx.elapsed : t;
    const dmp = shoreDamp(depthAt(x, z));
    if (dmp <= 0) return level;
    let y = 0;
    for (let i = 0; i < NW; i++) {
      const ph = (jsDir[i * 2] * x + jsDir[i * 2 + 1] * z) * jsKW[i * 2] - time * jsKW[i * 2 + 1];
      y += jsAQ[i * 2] * Math.sin(ph);
    }
    return level + y * dmp;
  }

  function normalAt(x, z, t, out) {
    const e = 0.35;
    const hx = heightAt(x + e, z, t) - heightAt(x - e, z, t);
    const hz = heightAt(x, z + e, t) - heightAt(x, z - e, t);
    const n = out || new T.Vector3();
    return n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  }

  /* ================================================================
     3. SHARED UNIFORMS
     ================================================================ */
  const mg = ctx.mat?.globals || {};
  const csm = ctx.render?.csm || null;

  const uniforms = {
    uTime: { value: 0 },
    uSurge: { value: 0.5 },
    uWindDir: { value: new T.Vector2(1, 0) },
    uWindStr: { value: windStr },

    uWave: { value: waveDir },
    uWaveKW: { value: waveKW },
    uWaveAQ: { value: waveAQ },
    uWaveFade: { value: waveFade },

    tSeabed: { value: tSeabed },
    uSeaRect: { value: new T.Vector4(SEABED.x0, SEABED.z0, 1 / SEABED.w, 1 / SEABED.h) },

    tRipple: { value: null },
    uRipRect: { value: new T.Vector4(0, 0, 1 / 128, 128) },

    uLevel: { value: level },

    /* colours (§2.1) */
    uShallow: { value: srgb(SEA.shallow) },
    uDeep: { value: srgb(SEA.deep) },
    uFoam: { value: srgb(SEA.foam) },
    uCaustic: { value: srgb(SEA.caustic) },
    uWet: { value: srgb(SEA.wet) },
    uSkyZenith: { value: srgb(SKY.zenith) },
    uSkyHorizon: { value: srgb(SKY.horizon) },
    uIsland: { value: srgb(LAND.grassShade) },

    /* lighting — shared by reference with ctx.mat so the sea and the
       land are lit by the same sun and go into shade together */
    uSunDir: mg.uSunDir || (csm ? csm.uniforms.uSunDir : { value: new T.Vector3(0.46, 0.72, 0.52).normalize() }),
    uSunColor: mg.uSunColor || { value: srgb(0xfff4dc) },
    uSunIntensity: mg.uSunIntensity || { value: 2.4 },
    uAmbSky: mg.uAmbSky || { value: srgb(SKY.horizon) },
    uAmbIntensity: mg.uAmbIntensity || { value: 0.6 },
    uShadowTint: mg.uShadowTint || { value: srgb(SHADOW.tint) },
    uShadowAmount: mg.uShadowAmount || { value: SHADOW.amount },
    uShadowValue: mg.uShadowValue || { value: 0.82 },
    uShadowBleed: mg.uShadowBleed || { value: 0.16 },
    uShadowFill: mg.uShadowFill || { value: 0.095 },

    uReflect: { value: q.waterReflect ? 1 : 0 },
    uSparkle: { value: tier === 'low' ? 0.55 : 1.0 },
    uColGain: { value: 1.26 },
    uDebug: { value: 0 },
    uCamPos: { value: new T.Vector3() },
  };
  if (csm) {
    uniforms.uCsmSplits = csm.uniforms.uCsmSplits;
    uniforms.uCsmBlur = csm.uniforms.uCsmBlur;
    uniforms.uCsmFade = csm.uniforms.uCsmFade;
  }

  /* ================================================================
     4. RIPPLE FIELD + FOAM
     ================================================================ */
  const ripples = createRipples(ctx);
  uniforms.tRipple.value = ripples.texture;
  uniforms.uRipRect.value.copy(ripples.rect);

  const shared = {
    uniforms,
    level,
    depthAt,
    groundAt: (x, z) => level - depthAt(x, z),
    heightAt,
  };
  const foam = createFoam(ctx, shared);
  group.add(foam.group);

  /* ================================================================
     5. THE OCEAN SHADER
     ================================================================ */
  const CSM_GLSL = csm ? csm.glsl() : 'float wCsmShadow( float viewZ, float rot ) { return 1.0; }';

  /* Wave + field sampling, shared verbatim by the vertex shader, the
     fragment shader and the prepass variant. */
  const FIELD_GLSL = /* glsl */`
  #define NW ${NW}
  uniform float uTime;
  uniform vec2  uWave[ NW ];       // direction
  uniform vec2  uWaveKW[ NW ];     // wavenumber, angular speed
  uniform vec2  uWaveAQ[ NW ];     // amplitude, steepness
  uniform vec2  uWaveFade[ NW ];   // distance fade in metres
  uniform sampler2D tSeabed;
  uniform vec4  uSeaRect;
  uniform sampler2D tRipple;
  uniform vec4  uRipRect;
  uniform float uLevel;

  /* depth in metres (x), seabed slope (y) */
  vec2 wSeabed( vec2 p ) {
    vec2 uv = ( p - uSeaRect.xy ) * uSeaRect.zw;
    vec4 t = texture2D( tSeabed, clamp( uv, vec2( 0.0005 ), vec2( 0.9995 ) ) );
    float dFine = t.r * 8.0 - 2.0;
    float dCoarse = t.g * 60.0 - 6.0;
    return vec2( mix( dFine, dCoarse, smoothstep( 4.4, 5.6, dCoarse ) ), t.b * 3.0 );
  }

  /* ripple field: r = foam, g = crest, b = trough, a = in-range */
  vec4 wRipple( vec2 p ) {
    vec2 uv = ( p - uRipRect.xy ) * uRipRect.z + 0.5;
    vec2 e = min( uv, 1.0 - uv );
    float inr = smoothstep( 0.0, 0.045, min( e.x, e.y ) );
    if ( inr <= 0.0 ) return vec4( 0.0 );
    vec4 t = texture2D( tRipple, uv );
    return vec4( t.rgb * inr, inr );
  }

  /* Gerstner. Returns the displacement; writes the analytic normal. */
  vec3 wGerstner( vec2 p, float dmp, float dist, out vec3 nrm ) {
    vec3 disp = vec3( 0.0 );
    vec3 acc = vec3( 0.0 );
    for ( int i = 0; i < NW; i ++ ) {
      vec2 d = uWave[ i ];
      float k = uWaveKW[ i ].x;
      float w = uWaveKW[ i ].y;
      float far = 1.0 - smoothstep( uWaveFade[ i ].x, uWaveFade[ i ].y, dist );
      float A = uWaveAQ[ i ].x * dmp * far;
      float Q = uWaveAQ[ i ].y;
      float ph = dot( d, p ) * k - uTime * w;
      float c = cos( ph ), s = sin( ph );
      disp.xz += d * ( Q * A * c );
      disp.y  += A * s;
      acc.xz  += d * ( k * A * c );
      acc.y   += Q * k * A * s;
    }
    nrm = normalize( vec3( -acc.x, 1.0 - acc.y, -acc.z ) );
    return disp;
  }
  `;

  const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
${FIELD_GLSL}

uniform vec3 uCamPos;

varying vec3  vWorld;
varying vec2  vBase;
varying vec3  vNormal;
varying float vDepth;
varying float vSlope;
varying float vViewZ;
varying float vDist;

void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vBase = worldPosition.xz;
  vDist = length( worldPosition.xz - uCamPos.xz );

  vec2 sb = wSeabed( vBase );
  vDepth = sb.x;
  vSlope = sb.y;

  float dmp = smoothstep( 0.05, 2.6, sb.x );
  vec3 nrm;
  vec3 disp = wGerstner( vBase, dmp, vDist, nrm );

  /* Transient surface: rings, wakes and splashes push the real
     geometry, they are not a texture painted on a flat plane. */
  vec4 rip = wRipple( vBase );
  float rh = ( rip.g - rip.b ) * 0.22 * dmp;

  worldPosition.xyz += disp;
  worldPosition.y += rh + uLevel;
  vNormal = nrm;
  vWorld = worldPosition.xyz;

  /* The shadow chunk wants a world normal to push the sample along. */
  vec3 transformedNormal = normalize( ( viewMatrix * vec4( nrm, 0.0 ) ).xyz );

  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  vViewZ = - mvPosition.z;

  #include <fog_vertex>
  #include <shadowmap_vertex>
}
`;

  const FRAG = /* glsl */`
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
${CSM_GLSL}
${FIELD_GLSL}

uniform float uSurge;
uniform vec2  uWindDir;
uniform float uWindStr;
uniform vec3  uCamPos;

uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uFoam;
uniform vec3  uCaustic;
uniform vec3  uWet;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform vec3  uIsland;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uAmbSky;
uniform float uAmbIntensity;
uniform vec3  uShadowTint;
uniform float uShadowAmount;
uniform float uShadowValue;
uniform float uShadowBleed;
uniform float uShadowFill;

uniform float uReflect;
uniform float uSparkle;
uniform float uColGain;
uniform float uDebug;

varying vec3  vWorld;
varying vec2  vBase;
varying vec3  vNormal;
varying float vDepth;
varying float vSlope;
varying float vViewZ;
varying float vDist;

const vec3 W_LUMA = vec3( 0.2126, 0.7152, 0.0722 );

float wHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

/* THE SHADOW LAW (§2.1), the reduced form. The sea is one saturated
   hue family, so the chroma-scaled machinery in shaders.js has nothing
   to decide here: it always takes the full rotation. Keeping the same
   tint / amount / value uniforms means the water goes into shade with
   the island rather than beside it. */
vec3 wSeaShade( vec3 c ) {
  vec3 t = pow( max( uShadowTint, vec3( 1e-5 ) ), vec3( 0.45455 ) );
  t /= max( max( t.r, max( t.g, t.b ) ), 1e-5 );
  vec3 g = pow( max( c, vec3( 0.0 ) ), vec3( 0.45455 ) );
  g *= mix( vec3( 1.0 ), t, uShadowAmount * 0.86 ) * uShadowValue;
  float y = dot( g, W_LUMA );
  g = mix( g, y * t * 1.28, uShadowBleed * 0.5 );
  g += t * uShadowFill * max( 0.0, 1.0 - y );
  float ym = dot( g, W_LUMA );
  g = ym + ( g - ym ) * 1.15;
  vec3 s = pow( max( g, vec3( 0.0 ) ), vec3( 2.2 ) );
  float yl = dot( max( c, vec3( 0.0 ) ), W_LUMA );
  float yv = dot( s, W_LUMA );
  return s * max( 1.0, ( yl * 0.70 ) / max( yv, 1e-5 ) );
}

/* A discrete step with exactly one pixel of roll-off. This is the
   whole difference between "banded" and "a gradient with extra steps"
   (§2.1: turquoise, BANDED not gradient). */
float wStepAA( float x, float edge ) {
  float aa = max( fwidth( x ) * 0.62, 0.0025 );
  return smoothstep( edge - aa, edge + aa, x );
}

void main() {
  vec3 Vv = uCamPos - vWorld;
  float dist = length( Vv );
  vec3 V = Vv / max( dist, 1e-4 );
  vec3 L = normalize( uSunDir );

  float depth = vDepth;
  float dmp = smoothstep( 0.05, 2.6, depth );

  /* THE NORMAL IS RECOMPUTED PER PIXEL, not interpolated. The disc's
     mid-field quads are metres across; a Gerstner normal interpolated
     over one of those is a flat facet, and every band, glint and
     specular step in this shader is a threshold on it. Four waves of
     sin/cos per fragment is the cheapest honest answer. */
  vec3 N;
  wGerstner( vBase, dmp, vDist, N );

  /* Close-range surface texture: two tiny wavelets that ride the
     swell without displacing it, so water a metre from the lens is
     not a mirror-smooth sheet. */
  float dtl = ( 1.0 - smoothstep( 14.0, 70.0, dist ) ) * dmp;
  if ( dtl > 0.001 ) {
    vec2 wd = uWindDir;
    vec2 p2 = vBase * 2.35 - wd * uTime * 1.15;
    vec2 p3 = vBase * 4.90 + vec2( -wd.y, wd.x ) * uTime * 0.85;
    float gx = cos( p2.x * 1.0 + p2.y * 0.63 ) * 0.055
             + cos( p3.x * 0.83 - p3.y * 0.51 ) * 0.024;
    float gz = cos( p2.y * 0.91 - p2.x * 0.44 ) * 0.055
             + cos( p3.y * 0.77 + p3.x * 0.61 ) * 0.024;
    N = normalize( N + vec3( gx, 0.0, gz ) * dtl );
  }

  /* Rings and wakes: sampled HERE, not interpolated from the vertex.
     A ring's edge is two texels wide in the field and the disc's
     quads are metres — read at vertex rate it would arrive as a soft
     blur, which is exactly the foam §5.4 forbids. */
  vec4 rip = wRipple( vBase );
  if ( rip.a > 0.0 ) {
    float e = 0.22;
    vec4 rx = wRipple( vBase + vec2( e, 0.0 ) );
    vec4 rz = wRipple( vBase + vec2( 0.0, e ) );
    float h0 = rip.g - rip.b, hx = rx.g - rx.b, hz = rz.g - rz.b;
    N = normalize( N + vec3( -( hx - h0 ), 0.0, -( hz - h0 ) ) * ( 0.9 / e ) * dmp );
  }

  bool under = ! gl_FrontFacing;
  if ( under ) N = - N;

  /* The bands are read at a depth the swell modulates, so a crest
     drags the shallow band outward and a trough pulls it back — the
     bands breathe instead of sitting on the water like paint. */
  float waveY = vWorld.y - uLevel;
  /* The swell only moves the bands where the seabed is close enough
     for a wave to matter. Applied at full strength everywhere, the
     deep band boundary sweeps back and forth through open water and
     the sea breaks up into a field of pale ovals — structure that
     belongs to nothing the player can see. */
  float dw = depth - waveY * 0.95 * ( 1.0 - smoothstep( 1.5, 6.5, depth ) );

  /* ---------------- banded depth colour (§2.1, §5.4) ---------------- */
  vec3 cSurf = mix( uShallow, uFoam, 0.42 );
  vec3 c1 = uShallow;
  vec3 c2 = mix( uShallow, uDeep, 0.34 );
  vec3 c3 = mix( uShallow, uDeep, 0.68 );
  vec3 c4 = uDeep;

  vec3 albedo = cSurf;
  albedo = mix( albedo, c1, wStepAA( dw, 0.85 ) );
  albedo = mix( albedo, c2, wStepAA( dw, 2.10 ) );
  albedo = mix( albedo, c3, wStepAA( dw, 4.60 ) );
  albedo = mix( albedo, c4, wStepAA( dw, 9.50 ) );
  /* §2.1's swatches are authored DISPLAY colours and ACES sits between
     here and the screen, taking about a fifth off a saturated blue.
     Pre-gain so what lands in the frame is the swatch rather than a
     navy copy of it — the same correction toon.js applies to its sky. */
  albedo *= uColGain;

  /* Far water loses its band structure to perspective long before it
     loses its colour; collapsing it there keeps the horizon from
     shimmering between two bands. */
  albedo = mix( albedo, c4, smoothstep( 420.0, 1500.0, dist ) * 0.75 );

  /* ---------------- caustics (§5.4) ----------------
     Two crossed stripe families, domain-warped and scrolling down the
     wind. Hard-stepped, because a soft caustic is just a stain. */
  float caus = 0.0;
  if ( depth < 6.5 ) {
    vec2 cp = vBase * 1.35 - uWindDir * uTime * 1.1;
    cp += 0.40 * vec2( sin( cp.y * 1.31 + uTime * 0.51 ),
                       cos( cp.x * 1.13 - uTime * 0.44 ) );
    float s1 = sin( cp.x * 1.7 + cp.y * 0.4 );
    float s2 = sin( cp.y * 1.9 - cp.x * 0.5 + 1.1 );
    float net = max( s1, s2 );
    caus = smoothstep( 0.42, 0.70, net ) * 0.6 + smoothstep( 0.80, 0.94, net ) * 0.4;
    caus *= ( 1.0 - smoothstep( 1.6, 6.5, depth ) ) * ( 1.0 - smoothstep( 90.0, 220.0, dist ) );
  }

  /* ---------------- key light ---------------- */
  float ndl = dot( N, L );
  float rot = wHash12( gl_FragCoord.xy ) * 6.2831853;
  float sh = wCsmShadow( vViewZ, rot );
  float band = smoothstep( -0.02, 0.16, ndl );
  float litK = band * sh;

  vec3 key = uSunColor * uSunIntensity;
  /* The sky ambient is a SATURATED colour and uAmbIntensity is its
     magnitude in unit-luminance terms — toon.js normalises it before
     use for exactly this reason. Multiplying by the raw #57C6D8-ish
     value instead lights everything with a 0.68-blue and 0.07-red
     source, which turned the white surf into periwinkle and pulled
     every band toward the same hue. */
  vec3 ambHue = uAmbSky / max( dot( uAmbSky, W_LUMA ), 1e-3 );
  vec3 amb = mix( vec3( 1.0 ), ambHue, 0.55 ) * uAmbIntensity;
  vec3 litCol = albedo * ( key * 0.92 + amb );
  vec3 shadeCol = wSeaShade( litCol );
  vec3 col = mix( shadeCol, litCol, litK );

  col += uCaustic * caus * ( 0.20 + 0.55 * litK ) * uSunIntensity * 0.72;

  /* ---------------- banded specular (§2.2) ---------------- */
  vec3 Hv = normalize( L + V );
  float sp = pow( max( dot( N, Hv ), 0.0 ), 78.0 );
  sp = floor( sp * 3.0 + 0.42 ) / 3.0;
  col += key * sp * 0.36 * litK;

  /* ---------------- sparkle glints ----------------
     Cells of open water switch on and off at their own rate. They only
     fire on a crest that is turned toward the sun, so the glitter path
     lies along the sun's reflection the way it does on a real sea, and
     they are pushed over the bloom prefilter on purpose. */
  {
    vec2 gp = vBase * 0.62;              // ~1.6 m cells
    vec2 id = floor( gp );
    float h = wHash12( id );
    float h2 = fract( h * 71.31 + 0.137 );
    /* Only a small minority of cells ever glint, and each is lit for a
       fifth of its cycle. Without both gates this becomes a field of
       white noise laid over the whole sea — which is what it was. */
    float live = step( 0.845, h );
    float ph = fract( h2 + uTime * ( 0.20 + h * 0.30 ) );
    float pulse = smoothstep( 0.0, 0.05, ph ) * ( 1.0 - smoothstep( 0.08, 0.26, ph ) );
    vec2 f = fract( gp ) - 0.5 - ( vec2( h, h2 ) - 0.5 ) * 0.5;
    float blob = 1.0 - smoothstep( 0.13, 0.21, length( f ) );
    /* Broad lobe about the sun's own reflection, so the glitter
       gathers into a path instead of dusting the horizon evenly. */
    float lobe = smoothstep( 0.18, 0.58, dot( N, Hv ) );
    float crest = smoothstep( 0.02, 0.30, waveY );
    /* World-space cells mean a glint two metres from the lens is a
       dinner plate. Fade the near field as well as the far one so the
       mark stays a mark. */
    float near = ( 1.0 - smoothstep( 55.0, 190.0, dist ) ) * smoothstep( 3.5, 13.0, dist );
    col += vec3( 3.0 ) * live * blob * pulse * lobe
         * ( 0.30 + 0.70 * crest ) * near * litK * uSparkle;
  }

  /* ---------------- stylised reflection (§5.4) ----------------
     Not a mirror and never a planar pass: the sky is evaluated
     analytically, banded into three steps, and darkened where the
     reflected ray runs into the island. Fresnel-weighted, so it only
     shows at grazing angles where a real sea goes silver. */
  if ( uReflect > 0.5 && ! under ) {
    vec3 R = reflect( -V, N );
    float up = clamp( R.y, 0.0, 1.0 );
    float t = smoothstep( 0.0, 0.5, up );
    t = floor( t * 3.0 + 0.35 ) / 3.0;
    vec3 sky = mix( uSkyHorizon, uSkyZenith, t );
    /* the island's own silhouette, sampled 34 m down the reflected ray */
    vec2 ahead = vBase + R.xz * 34.0 / max( up + 0.28, 0.28 );
    float dAhead = wSeabed( ahead ).x;
    float landK = 1.0 - smoothstep( -2.5, 0.6, dAhead );
    sky = mix( sky, uIsland * 0.72, landK * 0.8 );
    float fres = pow( 1.0 - max( dot( N, V ), 0.0 ), 4.2 );
    col = mix( col, sky * ( 0.55 + 0.45 * sh ), clamp( fres * 0.72, 0.0, 0.62 ) );
  }

  /* ================= FOAM — opaque, hard-edged (§5.4) ================= */
  vec3 foamLit = uFoam * ( key * 0.62 + amb );
  /* Foam in shade is still foam. The shadow law is written for
     saturated world albedos and a near-white put through it at full
     strength comes out lilac — surf standing in a cliff's shadow was
     reading as a grey ribbon. Take a third of the rotation and take
     the rest of the drop as value. */
  vec3 foamShade = mix( wSeaShade( foamLit ), foamLit * 0.74, 0.62 );
  vec3 foamCol = mix( foamShade, foamLit, litK );

  /* 1. the shoreline band. It follows the terrain intersection because
     it is a threshold on the same depth field the terrain was baked
     from, and it runs in and out because the threshold rides uSurge. */
  float sw = sin( vBase.x * 0.21 + vBase.y * 0.17 + uTime * 0.7 ) * 0.5
           + sin( vBase.x * 0.09 - vBase.y * 0.13 - uTime * 0.41 ) * 0.5;
  /* A second, shorter breakup so the surf is made of tongues a few
     metres long rather than one ribbon the length of the beach. */
  float sw2 = sin( vBase.x * 0.62 - vBase.y * 0.48 + uTime * 1.15 ) * 0.5
            + sin( vBase.x * 0.37 + vBase.y * 0.71 - uTime * 0.83 ) * 0.5;
  /* THE BAND IS SIZED IN METRES ALONG THE GROUND, then converted to a
     depth threshold through the local seabed slope. Thresholding depth
     directly makes the surf as wide as the beach is flat: on this
     island's steeper stretches a fixed 0.4 m of depth was half a metre
     of white and the shoreline had no surf on it at all. */
  float wide = mix( 1.3, 3.3, uSurge ) + sw * 0.85 + uWindStr * 0.9;
  float edge = clamp( wide * max( vSlope, 0.05 ), 0.05, 2.2 );
  float shoreFoam = 1.0 - wStepAA( dw, edge * ( 0.82 + 0.30 * sw2 ) );

  /* 2. a second, broken line further out — the previous wave, still
     dissolving. A LINE: bounded on both sides, or the "wave that has
     already passed" becomes a thirty-metre pale puddle sitting on the
     shallows, which is what an unbounded threshold gives you. */
  float od = edge * ( 2.1 + 0.7 * sw2 ) + 0.22;
  float outer = ( 1.0 - wStepAA( dw, od ) )
              * wStepAA( dw, od - 0.26 - 0.24 * uSurge )
              * smoothstep( 0.40, 0.58, sw * 0.35 + sw2 * 0.35 + 0.5 )
              * ( 0.45 + 0.55 * uSurge );
  shoreFoam = max( shoreFoam, outer * 0.78 );

  /* 3. whitecaps where the swell is steep and the wind is up */
  float cap = smoothstep( 0.72, 0.95, waveY / max( 0.32, 0.6 ) ) * smoothstep( 0.25, 0.75, uWindStr );
  cap *= 1.0 - smoothstep( 120.0, 400.0, dist );

  /* 4. rings, wakes and splashes */
  float ripFoam = wStepAA( rip.r, 0.30 );

  float foamMask = clamp( max( max( shoreFoam, ripFoam ), cap ), 0.0, 1.0 );
  foamMask *= 1.0 - smoothstep( 600.0, 1400.0, dist );
  col = mix( col, foamCol, foamMask );

  /* ---------------- seen from below ---------------- */
  if ( under ) {
    float fres = pow( 1.0 - max( dot( N, V ), 0.0 ), 2.2 );
    vec3 deepIn = mix( uDeep, uWet, 0.4 ) * ( key * 0.25 + amb );
    col = mix( mix( col * 0.9, deepIn, 0.45 ), foamLit * 0.9, fres * 0.75 );
    col = mix( col, foamCol, foamMask * 0.5 );
  }

  /* Channel inspector — WALLY.debug.waterDebug(n). Every band, foam
     edge and normal in here is a threshold, and a threshold is
     impossible to debug from a composited frame. */
  if ( uDebug > 0.5 ) {
    if ( uDebug < 1.5 )      col = albedo;
    else if ( uDebug < 2.5 ) col = vec3( litK );
    else if ( uDebug < 3.5 ) col = vec3( foamMask );
    else if ( uDebug < 4.5 ) col = vec3( clamp( depth / 12.0, 0.0, 1.0 ) );
    else if ( uDebug < 5.5 ) col = N * 0.5 + 0.5;
    else if ( uDebug < 6.5 ) col = vec3( caus );
    else                     col = vec3( rip.r, rip.g, rip.b );
  }

  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    if ( uDebug < 0.5 ) col = mix( col, fogColor, fogFactor );
  #endif

  gl_FragColor = vec4( col, 1.0 );
}
`;

  /* Prepass variant: same displacement, so AO, DOF and the outline
     pass all see the surface where it actually is. */
  const ND_FRAG = /* glsl */`
precision highp float;
varying vec3 vNormal;
varying float vViewZ;
uniform mat4 viewMatrix2;
void main() {
  vec3 n = normalize( ( viewMatrix2 * vec4( normalize( vNormal ), 0.0 ) ).xyz );
  gl_FragColor = vec4( n * 0.5 + 0.5, vViewZ );
}
`;

  const oceanUniforms = T.UniformsUtils.merge([
    T.UniformsLib.lights,
    T.UniformsLib.fog,
  ]);
  Object.assign(oceanUniforms, uniforms);

  const oceanMat = new T.ShaderMaterial({
    name: 'water.ocean',
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: oceanUniforms,
    lights: true,
    fog: true,
    side: T.DoubleSide,
  });
  oceanMat.userData.noOutline = true;

  const ndUniforms = Object.assign({ viewMatrix2: { value: new T.Matrix4() } }, uniforms);
  const oceanND = new T.ShaderMaterial({
    name: 'water.ocean.nd',
    vertexShader: VERT.replace('#include <shadowmap_pars_vertex>', '')
                      .replace('#include <shadowmap_vertex>', ''),
    fragmentShader: ND_FRAG,
    uniforms: ndUniforms,
    side: T.DoubleSide,
  });
  oceanMat.userData.ndMaterial = oceanND;

  /* ================================================================
     6. THE OCEAN DISC
     ================================================================ */
  function buildDisc(rings, sectors) {
    const nv = (rings + 1) * (sectors + 1) + 1;
    const pos = new Float32Array(nv * 3);
    const idx = [];
    /* centre vertex */
    pos[0] = 0; pos[1] = 0; pos[2] = 0;
    const growth = Math.pow(DISC_MAX / DISC_MIN, 1 / rings);
    for (let i = 0; i <= rings; i++) {
      const r = DISC_MIN * Math.pow(growth, i);
      for (let j = 0; j <= sectors; j++) {
        const a = (j / sectors) * Math.PI * 2;
        const k = 1 + i * (sectors + 1) + j;
        pos[k * 3] = Math.cos(a) * r;
        pos[k * 3 + 1] = 0;
        pos[k * 3 + 2] = Math.sin(a) * r;
      }
    }
    for (let j = 0; j < sectors; j++) idx.push(0, 1 + j + 1, 1 + j);
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < sectors; j++) {
        const a0 = 1 + i * (sectors + 1) + j;
        const a1 = a0 + 1;
        const b0 = a0 + (sectors + 1);
        const b1 = b0 + 1;
        /* Wound so the face normal is +Y. Get this backwards and every
           fragment takes the gl_FrontFacing "seen from below" branch,
           which flips N, drives N·L negative and renders the entire
           ocean through the shadow law. */
        idx.push(a0, a1, b0, a1, b1, b0);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setIndex(idx.length > 65535 ? new T.Uint32BufferAttribute(idx, 1) : idx);
    g.boundingSphere = new T.Sphere(new T.Vector3(), DISC_MAX * 1.02);
    return g;
  }

  const disc = DISC[tier] || DISC.high;
  const oceanGeo = buildDisc(disc.rings, disc.sectors);
  const ocean = new T.Mesh(oceanGeo, oceanMat);
  ocean.name = 'water.ocean';
  ocean.frustumCulled = false;
  ocean.castShadow = false;
  ocean.receiveShadow = true;
  ocean.renderOrder = 1;
  group.add(ocean);

  /* ================================================================
     7. UNDERWATER WASH
     ================================================================ */
  const underMat = new T.ShaderMaterial({
    name: 'water.under',
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uTime: uniforms.uTime,
      uDeep: uniforms.uDeep,
      uShallow: uniforms.uShallow,
      uCaustic: uniforms.uCaustic,
      uAmount: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4( position.xy * 2.0, 0.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform vec3 uCaustic;
      uniform float uAmount;
      varying vec2 vUv;
      void main() {
        if ( uAmount <= 0.001 ) discard;
        /* A stylised wash, not a fog volume: brighter toward the
           surface, banded light shafts drifting across it. */
        float up = smoothstep( 0.05, 0.85, vUv.y );
        vec3 col = mix( uDeep * 0.75, mix( uShallow, uCaustic, 0.35 ), up );
        float bands = sin( ( vUv.x * 7.0 + vUv.y * 2.2 ) + uTime * 0.5 )
                    + sin( ( vUv.x * 13.0 - vUv.y * 3.1 ) - uTime * 0.31 );
        col += uCaustic * smoothstep( 1.1, 1.8, bands ) * 0.18 * up;
        float vig = 1.0 - 0.35 * length( vUv - 0.5 );
        gl_FragColor = vec4( col * vig, uAmount * 0.52 );
      }
    `,
  });
  const underQuad = new T.Mesh(new T.PlaneGeometry(1, 1), underMat);
  underQuad.name = 'water.underwater';
  underQuad.frustumCulled = false;
  underQuad.renderOrder = 9000;
  underQuad.visible = false;
  underQuad.userData.noPrepass = true;
  underQuad.userData.noOutline = true;
  group.add(underQuad);

  /* ================================================================
     8. STAND-IN LANDMASS (only while world/ is a stub)
     ================================================================ */
  let proxy = null;
  if (!hasTerrain && ctx.mat) {
    const A = tier === 'low' ? 192 : 288;
    const R = 80;
    const nv = (A + 1) * R;
    const pos = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const idx = [];
    const cSand = srgb(LAND.sand), cGrass = srgb(LAND.grassLit), cDeep = srgb(LAND.dirt);
    const tmp = new T.Color();
    for (let a = 0; a <= A; a++) {
      const th = (a / A) * Math.PI * 2;
      const dx = Math.cos(th), dz = Math.sin(th);
      const re = shoreRadius(dx, dz);
      for (let k = 0; k < R; k++) {
        const t = k / (R - 1);
        /* dense through the coastal band, coarse inland and offshore */
        let f;
        if (t < 0.40) f = (t / 0.40) * 0.86;
        else if (t < 0.85) f = 0.86 + ((t - 0.40) / 0.45) * 0.18;
        else f = 1.04 + ((t - 0.85) / 0.15) * 0.22;
        const s = re * f;
        const x = dx * s, z = dz * s;
        const y = Math.max(fallbackGround(x, z), -6);
        const i = a * R + k;
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        if (y < -0.2) tmp.copy(cSand).lerp(cDeep, smoothstep(-0.2, -4, y));
        else tmp.copy(cSand).lerp(cGrass, smoothstep(1.4, 5.5, y));
        col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
      }
    }
    for (let a = 0; a < A; a++) {
      for (let k = 0; k < R - 1; k++) {
        const i0 = a * R + k, i1 = (a + 1) * R + k;
        idx.push(i0, i0 + 1, i1, i1, i0 + 1, i1 + 1);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = ctx.mat.toon({
      color: 0xffffff, vertexColors: true, grain: 0.010, grainScale: 2.4,
      macro: 0.9, macroScale: 0.05, spec: 0.02, rim: 0.25,
      name: 'water.standInLand',
    });
    proxy = new T.Mesh(g, m);
    proxy.name = 'water.standInLand';
    proxy.receiveShadow = true;
    proxy.castShadow = true;
    group.add(proxy);
  }

  /* ================================================================
     9. WAKES
     ================================================================ */
  const wakes = [];
  const _wp = new T.Vector3();
  const _fwd = new T.Vector3();

  function wake(obj, opts = {}) {
    const w = {
      obj,
      width: opts.width ?? 0.55,
      strength: opts.strength ?? 0.7,
      minSpeed: opts.minSpeed ?? 0.55,
      life: opts.life ?? 2.4,
      idleRing: opts.idleRing ?? true,
      _last: new T.Vector3(),
      _t: 0, _idle: 0, _init: false,
      dead: false,
      dispose() { w.dead = true; },
    };
    wakes.push(w);
    return w;
  }

  function wakePos(w, out) {
    const o = w.obj;
    if (!o) return null;
    if (o.isObject3D) { o.getWorldPosition(out); return out; }
    if (o.position) { out.copy(o.position); return out; }
    if (Number.isFinite(o.x)) { out.set(o.x, o.y ?? level, o.z); return out; }
    return null;
  }

  function updateWakes(dt) {
    for (let i = wakes.length - 1; i >= 0; i--) {
      const w = wakes[i];
      if (w.dead) { wakes.splice(i, 1); continue; }
      const p = wakePos(w, _wp);
      if (!p) continue;
      if (!w._init) { w._last.copy(p); w._init = true; continue; }

      const dx = p.x - w._last.x, dz = p.z - w._last.z;
      const moved = Math.hypot(dx, dz);
      const sp = moved / Math.max(dt, 1e-4);
      const surf = heightAt(p.x, p.z);
      const near = Math.abs(p.y - surf) < 1.6 && depthAt(p.x, p.z) > 0.02;
      if (!near) { w._last.copy(p); continue; }

      if (sp > w.minSpeed && moved > 1e-4) {
        /* Emit per METRE travelled, not per second: a time-based
           interval lays a solid slab of foam at speed and a dotted
           line at a crawl. */
        w._t -= moved;
        if (w._t <= 0) {
          w._t = 0.55;
          const fx = dx / moved, fz = dz / moved;
          const nx = -fz, nz = fx;
          const spread = w.width * 0.9;
          const s = clamp(w.strength * (0.30 + sp * 0.14), 0.1, 0.95);
          /* Two arms that drift outward at the Kelvin angle, plus the
             churn dragged along directly behind the hull. */
          const drift = 0.34 * sp;
          for (let side = -1; side <= 1; side += 2) {
            ripples.wakeBlob(
              p.x + nx * spread * side, p.z + nz * spread * side,
              fx + nx * side * 0.45, fz + nz * side * 0.45,
              s, w.width * 0.42, w.life,
              nx * side * drift, nz * side * drift,
            );
          }
          ripples.wakeBlob(p.x - fx * spread * 0.8, p.z - fz * spread * 0.8,
                           fx, fz, s * 0.7, w.width * 0.38, w.life * 0.55,
                           -fx * sp * 0.06, -fz * sp * 0.06);
        }
        w._idle = 0;
      } else if (w.idleRing) {
        /* Something sitting in the water still gets a foam ring (§5.4). */
        w._idle -= dt;
        if (w._idle <= 0) {
          w._idle = 0.55;
          ripples.ring(p.x, p.z, 0.30, w.width * 1.15);
        }
      }
      w._last.copy(p);
    }
  }

  /* ================================================================
     10. PUBLIC API
     ================================================================ */
  const _v = new T.Vector3();

  function toVec(p, y) {
    if (!p) return null;
    if (Number.isFinite(p.x)) return _v.set(p.x, p.y ?? y ?? level, p.z);
    if (Array.isArray(p)) return _v.set(p[0], p[1] ?? y ?? level, p[2]);
    return null;
  }

  const api = {
    level,
    heightAt,
    normalAt,
    depthAt,
    /** Seabed / terrain height as the water sees it. */
    groundAt: (x, z) => level - depthAt(x, z),
    isUnder(p) {
      const v = toVec(p);
      if (!v) return false;
      return v.y < heightAt(v.x, v.z) - 0.02;
    },

    /** A body entering the water: foam disc, rings, droplets, sound. */
    splash(p, strength = 0.7, radius = null) {
      const v = toVec(p);
      if (!v) return api;
      const s = clamp(strength, 0.05, 1);
      const r = radius ?? (0.35 + s * 0.55);
      ripples.splash(v.x, v.z, s, r);
      foam.burst(v.x, heightAt(v.x, v.z), v.z, s);
      ctx.bus?.emit('sfx', {
        name: s > 0.45 ? 'splash' : 'splash.small',
        position: { x: v.x, y: level, z: v.z },
        gain: 0.35 + s * 0.5,
      });
      return api;
    },

    /** A single expanding ring — footsteps, bobbing, an oar. */
    ripple(p, radius = 0.4, strength = 0.5) {
      const v = toVec(p);
      if (!v) return api;
      ripples.ring(v.x, v.z, strength, radius);
      return api;
    },

    /** Persistent V wake behind anything that moves. Returns a handle
        with .dispose(); pass {width, strength, minSpeed, life}. */
    wake,

    /** Ripple field, if another module wants to splat into it. */
    ripples,
    foam,
    ocean,
    group,
    uniforms,
    material: oceanMat,
    seabedTexture: tSeabed,

    /** Re-read the terrain. Call after the world changes shape. */
    rebuild() {
      bakeSeabed();
      tSeabed.needsUpdate = true;
      foam.rebuildSkirt();
      return api;
    },

    get surge() { return uniforms.uSurge.value; },
    get windStrength() { return windStr; },

    update(dt, elapsed) {
      uniforms.uTime.value = elapsed;
      refreshWaves();
      const wd = ctx.wind?.uniforms.uWindDir.value;
      if (wd) uniforms.uWindDir.value.copy(wd);
      uniforms.uWindStr.value = clamp(windStr, 0, 1);

      /* The swell that drives the beach run-up is the dominant wave's
         own period, so the surf and the sea are one motion. */
      const w0 = waveKW[0].y;
      uniforms.uSurge.value = 0.5 + 0.5 * Math.sin(elapsed * w0 * 0.5 - 1.1);

      updateWakes(dt);
      ripples.update(dt);
      foam.update(dt);

      /* Underwater wash. */
      const cam = ctx.camera;
      if (cam) {
        const surf = heightAt(cam.position.x, cam.position.z);
        const sub = clamp((surf - cam.position.y) / 0.55, 0, 1);
        underMat.uniforms.uAmount.value = damp(underMat.uniforms.uAmount.value, sub, 9, dt);
        underQuad.visible = underMat.uniforms.uAmount.value > 0.004;
      }

      /* Drop the stand-in the moment real terrain shows up. */
      if (proxy && worldHeight(0, 0) !== null) {
        group.remove(proxy);
        proxy.geometry.dispose();
        proxy = null;
        api.rebuild();
      }
    },

    lateUpdate() {
      const cam = ctx.camera;
      if (!cam) return;
      uniforms.uCamPos.value.copy(cam.position);
      /* The disc follows the camera so the vertex budget is always
         spent where it can be seen. Snapped to a metre so the
         tessellation cannot crawl under a slow pan. */
      ocean.position.set(Math.round(cam.position.x), 0, Math.round(cam.position.z));
      ocean.updateMatrixWorld();

      /* The ripple field follows the player — unless the camera has
         been taken somewhere else (a debug pose, a cutscene, a vista),
         in which case it follows what is actually on screen. A field
         centred four hundred metres behind the lens is a field that
         does nothing. */
      const pl = ctx.wally?.root?.position;
      let cx = cam.position.x, cz = cam.position.z;
      if (pl && Math.hypot(pl.x - cx, pl.z - cz) < ripples.span * 0.42) {
        cx = pl.x; cz = pl.z;
      } else {
        cam.getWorldDirection(_fwd);
        cx += _fwd.x * ripples.span * 0.26;
        cz += _fwd.z * ripples.span * 0.26;
      }
      ripples.setCenter(cx, cz);
      uniforms.uRipRect.value.copy(ripples.rect);

      ndUniforms.viewMatrix2.value.copy(cam.matrixWorldInverse);
      ripples.render(ctx.renderer);
    },

    dispose() {
      ctx.scene.remove(group);
      oceanGeo.dispose();
      oceanMat.dispose();
      oceanND.dispose();
      underMat.dispose();
      underQuad.geometry.dispose();
      tSeabed.dispose();
      ripples.dispose();
      foam.dispose();
      if (proxy) proxy.geometry.dispose();
    },
  };

  /* ================================================================
     11. BUS WIRING — physics already tells us where the foam goes
     ================================================================ */
  const bus = ctx.bus;
  if (bus) {
    bus.on('water:splash', (e) => {
      if (!e) return;
      ripples.splash(e.x, e.z, e.strength ?? 0.7, e.radius ?? 0.5);
      foam.burst(e.x, e.y ?? level, e.z, e.strength ?? 0.7);
      bus.emit('sfx', {
        name: (e.strength ?? 0.7) > 0.45 ? 'splash' : 'splash.small',
        position: { x: e.x, y: e.y ?? level, z: e.z },
      });
    });
    bus.on('water:ripple', (e) => {
      if (!e) return;
      ripples.ring(e.x, e.z, e.strength ?? 0.4, e.radius ?? 0.4);
      if (e.entering) foam.burst(e.x, e.y ?? level, e.z, 0.45, 7);
    });
    /* A footstep in the shallows makes a ring even when the controller
       does not think it is wading. */
    bus.on('phys:step', (e) => {
      const p = e?.position;
      if (!p) return;
      const d = depthAt(p.x, p.z);
      if (d > 0.02 && d < 0.9) {
        ripples.ring(p.x, p.z, 0.28 + (e.running ? 0.2 : 0), 0.3);
        if (d > 0.18) foam.burst(p.x, level, p.z, 0.3, 5);
      }
    });
    bus.on('phys:land', (e) => {
      const p = e?.position;
      if (!p) return;
      if (depthAt(p.x, p.z) > 0.05) {
        api.splash({ x: p.x, y: level, z: p.z }, clamp((e.impact ?? 3) / 9, 0.25, 1));
      }
    });
  }

  /* ================================================================
     12. DEBUG
     ================================================================ */
  const dbg = (typeof window !== 'undefined' && window.WALLY?.debug) || null;
  if (dbg) {
    let posed = null;
    let wrapped = false;

    function applyPose() {
      if (!posed || !ctx.camera) return;
      ctx.camera.position.copy(posed.pos);
      ctx.camera.lookAt(posed.tgt);
      if (posed.fov) { ctx.camera.fov = posed.fov; ctx.camera.updateProjectionMatrix(); }
      ctx.camera.updateMatrixWorld();
    }

    /* The camera rig boots after us and runs its lateUpdate after ours,
       so a debug pose has to be re-applied immediately before the draw.
       Wrapping render() is the only hook that is guaranteed to be last;
       it is restored when the pose is cleared. */
    function ensureWrap() {
      if (wrapped || !ctx.render?.render) return;
      const inner = ctx.render.render;
      ctx.render.render = function () {
        if (posed) applyPose();
        return inner.apply(this, arguments);
      };
      ctx.render.render._wallyWaterWrapped = inner;
      wrapped = true;
    }

    /* A point on the coast, and the outward + alongshore unit vectors
       there, so the presets follow the real shoreline. */
    function coast(theta) {
      const dx = Math.cos(theta), dz = Math.sin(theta);
      const ex = RX * dx, ez = RZ * dz;
      const re = Math.hypot(ex, ez);
      const ux = ex / re, uz = ez / re;
      let r = re;
      for (let s = re * 0.8; s < re * 1.25; s += 1.5) {
        if (depthAt(ux * s, uz * s) > 0) { r = s; break; }
      }
      return { x: ux * r, z: uz * r, ux, uz, tx: -uz, tz: ux };
    }

    const PRESETS = {
      /* Low and reverent (§2.5): the surf line runs away from the lens,
         open sea to one side, wet sand to the other. */
      shore(c) {
        return {
          pos: new T.Vector3(c.x + c.ux * 15 + c.tx * -26, 3.6, c.z + c.uz * 15 + c.tz * -26),
          tgt: new T.Vector3(c.x + c.ux * -3 + c.tx * 24, 1.0, c.z + c.uz * -3 + c.tz * 24),
          fov: 52,
        };
      },
      open(c) {
        return {
          pos: new T.Vector3(c.x + c.ux * 300 + c.tx * 90, 4.2, c.z + c.uz * 300 + c.tz * 90),
          tgt: new T.Vector3(c.x + c.ux * 60 + c.tx * 200, 8, c.z + c.uz * 60 + c.tz * 200),
          fov: 55,
        };
      },
      /* Nose-down on the surf line: the run-up, the wet sand, the foam
         band and the caustics all in one frame. */
      surf(c) {
        return {
          pos: new T.Vector3(c.x + c.ux * 11 + c.tx * -7, 2.5, c.z + c.uz * 11 + c.tz * -7),
          tgt: new T.Vector3(c.x + c.ux * -3.5 + c.tx * 5, 0.4, c.z + c.uz * -3.5 + c.tz * 5),
          fov: 48,
        };
      },
      under(c) {
        return {
          pos: new T.Vector3(c.x + c.ux * 34, -0.85, c.z + c.uz * 34),
          tgt: new T.Vector3(c.x + c.ux * 2, 1.4, c.z + c.uz * 2),
          fov: 60,
        };
      },
    };

    dbg.waterCam = (name = 'shore', theta = -0.62) => {
      if (!name) {
        posed = null;
        if (wrapped && ctx.render.render._wallyWaterWrapped) {
          ctx.render.render = ctx.render.render._wallyWaterWrapped;
          wrapped = false;
        }
        return 'cleared';
      }
      const make = PRESETS[name] || PRESETS.shore;
      posed = make(coast(theta));
      ensureWrap();
      applyPose();
      /* Give the shot something happening: a wake crossing the frame
         and a couple of rings settling. */
      if (name !== 'under') dbg.splashTest(posed.tgt);
      return { name, pos: posed.pos.toArray().map((v) => +v.toFixed(1)) };
    };

    /* A moving object so the V wake exists in a still frame. */
    let testWake = null;
    const testObj = { position: new T.Vector3() };
    let testT = 0, testBase = null;

    dbg.splashTest = (at = null) => {
      let c = at ? { x: at.x, z: at.z } : coast(-0.62);
      /* Put the moving test object in water deep enough to wake. */
      const cc = coast(-0.62);
      c = { x: cc.x + cc.ux * 26, z: cc.z + cc.uz * 26 };
      testBase = new T.Vector3(c.x, level, c.z);
      if (!testWake) testWake = wake(testObj, { width: 0.75, strength: 0.9 });
      testT = 0;
      for (let i = 0; i < 5; i++) {
        const a = i * 1.7;
        const px = c.x + Math.cos(a) * (6 + i * 5);
        const pz = c.z + Math.sin(a) * (6 + i * 5);
        if (depthAt(px, pz) > 0.25) api.splash({ x: px, y: level, z: pz }, 0.35 + i * 0.13);
      }
      return 'ok';
    };

    dbg.waterSurge = (v) => { uniforms.uSurge.value = clamp(v, 0, 1); return v; };
    /* 0 off, 1 albedo, 2 litK, 3 foam, 4 depth, 5 normal, 6 caustics,
       7 ripple field */
    dbg.waterDebug = (n = 0) => { uniforms.uDebug.value = n; return n; };
    dbg.waterStats = () => ({
      tier, seabed: SB, disc: `${disc.rings}x${disc.sectors}`,
      ripples: ripples.count, drops: foam.dropCount,
      surge: +uniforms.uSurge.value.toFixed(2), wind: +windStr.toFixed(2),
      terrain: hasTerrain ? 'ctx.world' : 'stand-in',
      depthAt0: +depthAt(0, 0).toFixed(2),
    });

    /* the test object is driven from the module's own update */
    const baseUpdate = api.update;
    api.update = function (dt, elapsed) {
      baseUpdate.call(api, dt, elapsed);
      if (testBase) {
        testT += dt;
        const a = testT * 0.30;
        testObj.position.set(
          testBase.x + Math.cos(a) * 12,
          level,
          testBase.z + Math.sin(a) * 12,
        );
      }
    };
  }

  return api;
}

export default init;
