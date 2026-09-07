/* ============================================================
   toon.js — ctx.mat, the material factory.

   Every surface in this game comes out of this file, which is why it
   is the one place the lighting model is written down. ART_DIRECTION
   §2.2 and §5, implemented once:

     - two-band ramp, smoothstep terminator (never a hard step)
     - shadow = mix( albedo, albedo * SHADOW.tint, 0.55 )
       a hue rotation toward blue-violet plus a modest value drop.
       NOT albedo * 0.4. NOT grey. This single line is the difference
       between Wind Waker and mud.
     - narrow warm rim on world objects, suppressed on clay
     - soft fresnel sky bounce on upward faces
     - velvet grain perturbing the normal, triplanar in *object* space
       so it sticks to the surface under animation and never crawls
     - CSM lookup with a wide Poisson PCF and a generous normal bias

   Built as a hand-written ShaderMaterial rather than an
   onBeforeCompile patch, because the two-band model shares almost
   nothing with three's BRDF and patching it would mean deleting more
   than we keep. Everything three's plumbing gives us is wired back in
   by hand and all four of the things other agents depend on work:

     shadows    <shadowmap_pars_vertex/fragment> + our own PCF
     fog        <fog_pars_*>, material.fog = true
     instancing USE_INSTANCING is object-driven, applied by hand in
                the vertex shader (InstancedMesh + BatchedMesh)
     skinning   <skinning_pars_vertex> + skinbase/skinnormal/skinning

   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { CLAY, SHADOW, SKY, LAND, BUILD, BRAND } from '../core/palette.js';
import { lerp, smoothstep } from '../core/contracts.js';
import { GLSL_NOISE, GLSL_GRAIN, GLSL_SHADOW } from './shaders.js';
import { WIND_GLSL } from '../core/wind.js';
import { createTexGen } from './texgen.js';

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const toColor = (c) => (c instanceof THREE.Color ? c.clone() : srgb(c));

export async function init(ctx) {
  const q = ctx.quality;
  const csm = ctx.render?.csm;
  const tex = createTexGen(ctx);

  /* ================================================================
     Shared global uniforms. Every material holds these by reference,
     so the sky module can retint the whole world in one assignment.
     ================================================================ */
  const globals = {
    uTime: { value: 0 },

    /* sun — owned by csm.js so the shadow cameras and the shading
       can never disagree about where the light is */
    uSunDir: csm ? csm.uniforms.uSunDir : { value: new THREE.Vector3(0.46, 0.72, 0.52).normalize() },
    uSunColor: csm ? csm.uniforms.uSunColor : { value: srgb(0xfff4dc) },
    uSunIntensity: csm ? csm.uniforms.uSunIntensity : { value: 2.4 },

    /* ambient — a two-lobe sky/ground bounce, not a flat term.
       uAmbSat is how much of the sky's hue survives; the rest of the
       colour in a shadow comes from the shadow law below. */
    uAmbSky: { value: srgb(SKY.horizon) },
    uAmbGround: { value: srgb(LAND.sand) },
    uAmbIntensity: { value: 0.60 },
    uAmbSat: { value: 0.55 },

    /* the shadow law (§2.1). amount = hue rotation, value = the
       "modest value drop", bleed = how much real sky-blue a shadow
       picks up on top of the multiply, fill = absolute sky irradiance.

       `amount`/`value` are a multiply and cannot wrap the hue, so they
       are the law proper. `bleed` and `fill` REPLACE colour, which is
       the only way a dark or saturated albedo picks up any blue at
       all — and also the only way a surface can lose its identity.

       These two are much smaller than they were (0.38 -> 0.16,
       0.115 -> 0.095) because they no longer have to carry the hue
       rotation on their own: wShadeLaw() now scales the *multiply* by
       the surface's chroma, so a saturated albedo gets a real rotation
       out of the law proper and the replacing terms are back to being
       what their names say — a sky bounce and a sky fill. At 0.38 the
       bleed alone repainted every low-saturation surface in the frame,
       and the cream stucco wall measured a 175 degree hue flip into
       blue-grey slate. */
    uShadowTint: { value: srgb(SHADOW.tint) },
    /* §2.1 fixes the law at lerp( albedo, albedo * tint, 0.55 ), which
       is SHADOW.amount in palette.js. Read, never overridden here. */
    uShadowAmount: { value: SHADOW.amount },
    uShadowValue: { value: 0.82 },
    uShadowBleed: { value: 0.16 },
    uShadowFill:  { value: 0.095 },

    uRimColor: { value: srgb(0xffe6bc) },

    /* ---- THE ONE LOCAL LIGHT (see setLocalLight) ----
       This pipeline is sun-only: `lights: true` on the material buys
       the fog and shadow uniform blocks, and nothing in FRAG has ever
       read pointLights[] — so a THREE.PointLight added to the scene by
       any module lights precisely nothing and costs a uniform upload.
       Which was fine for a game lit by one sun, and stayed fine right
       up until something in it caught FIRE.

       ONE, DELIBERATELY. A general local-light loop puts a per-light
       cost on every fragment of every surface in the game for a
       feature with exactly one caller. A single light is two vec3s
       and a float behind a uniform branch that a whole draw takes
       together: when uLocalCol is black — every frame in which nothing
       is alight — it is one compare. If a second caller ever needs
       one, that is the moment to make it an array, not before. */
    uLocalPos: { value: new THREE.Vector3(0, -9999, 0) },
    uLocalCol: { value: new THREE.Color(0, 0, 0) },
    uLocalRange: { value: 24.0 },

    /* outline: world units per screen pixel at 1 m, refreshed each
       frame from the live camera + drawing buffer. Kept for any
       module that wants a world-space "one pixel"; the hull itself
       now expands in screen space and reads uOutlineRes. */
    uPixelScale: { value: 0.0025 },
    uOutlineRes: { value: new THREE.Vector2(1600, 900) },

    /* Global outline trim. uOutlineScale is a live multiplier on every
       authored width (debug + quality tiers). uOutlineFade is
       ( near m, far m, width scale at far ): the stroke holds its full
       weight inside `near`, then thins and desaturates toward the
       surface's own shade.

       The envelope used to be ( 48, 150, 0.30 ), read as "the outline
       is a near-field device". That is not what §2.2 says. §2.2 asks
       for a width that scales with distance so it *stays* ~1.6 px,
       and §0 makes the bible authoritative over the implementation's
       own reasoning. Measured in the vista framing, 48 m constant put
       only 4 of 101 visible outlined meshes inside the full-weight
       band and ran 74 of them at or below 0.53 px — sub-pixel, i.e.
       no line at all, and the whole mid-ground of the city held by
       value contrast alone.

       So the near plane moves out to 120 m to coincide with §2.4's
       haze onset — *atmosphere* retires the stroke, not an arbitrary
       width ramp — the roll-off runs to 300 m, and the far floor goes
       to 0.55 so a 200 m roof still carries about 0.9 px of its own
       weight instead of half a pixel of nothing. */
    uOutlineScale: { value: 1.0 },
    uOutlineFade: { value: new THREE.Vector3(120, 300, 0.55) },

    /* textures */
    tGrain: { value: tex.grain(256, 48, 26) },
    tPacked: { value: tex.packed(256) },
    tWood: { value: tex.wood(256) },
    tPlaster: { value: tex.plaster(256) },
  };

  if (csm) {
    globals.uCsmSplits = csm.uniforms.uCsmSplits;
    globals.uCsmBlur = csm.uniforms.uCsmBlur;
    globals.uCsmFade = csm.uniforms.uCsmFade;
  }

  const CSM_GLSL = csm ? csm.glsl() : 'float wCsmShadow( float viewZ, float rot ) { return 1.0; }';

  /* ================================================================
     Shaders
     ================================================================ */

  const VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>

#ifdef TOON_WIND
${WIND_GLSL}
uniform float uWindWeight;
uniform float uWindPhase;
uniform vec2  uWindHeight;   // x = base y, y = 1/height
#endif

uniform vec2 uUvScale;

varying vec3  vWorldPos;
varying vec3  vWorldNormal;
varying vec3  vViewDir;
varying float vViewZ;
varying vec3  vObjPos;
varying vec3  vObjNormal;
varying vec2  vUvT;

void main() {
  vUvT = uv * uUvScale;

  #include <color_vertex>
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>

  /* Triplanar projection is done in OBJECT space (so detail sticks to
     animated skin), which means the blend weights have to come from
     the object-space normal too — using the world normal here streaks
     every rotated plane in the game. */
  vObjNormal = objectNormal;

  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>

  /* Grain lives in object space so it travels with the skin. For
     instanced geometry we offset by the instance translation, or every
     copy of a barrel would wear identical scratches. */
  vObjPos = position;
  #ifdef USE_INSTANCING
    vObjPos += vec3( instanceMatrix[ 3 ].x, instanceMatrix[ 3 ].y, instanceMatrix[ 3 ].z ) * 0.373;
  #endif

  vec4 worldPosition = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    worldPosition = batchingMatrix * worldPosition;
  #endif
  #ifdef USE_INSTANCING
    worldPosition = instanceMatrix * worldPosition;
  #endif
  worldPosition = modelMatrix * worldPosition;

  #ifdef TOON_WIND
    float wH = clamp( ( position.y - uWindHeight.x ) * uWindHeight.y, 0.0, 1.0 );
    float wPh = uWindPhase + dot( worldPosition.xz, vec2( 0.71, 0.43 ) );
    worldPosition.xyz += windOffset( worldPosition.xyz, wH * uWindWeight, wPh );
  #endif

  vWorldPos = worldPosition.xyz;
  vWorldNormal = normalize( inverseTransformDirection( transformedNormal, viewMatrix ) );
  vViewDir = cameraPosition - vWorldPos;

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
#include <color_pars_fragment>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
${CSM_GLSL}
${GLSL_NOISE}
${GLSL_GRAIN}
${GLSL_SHADOW}

uniform vec3  diffuse;
uniform float opacity;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uAmbSky;
uniform vec3  uAmbGround;
uniform float uAmbIntensity;
uniform float uAmbSat;
uniform vec3  uShadowTint;
uniform float uShadowAmount;
uniform float uShadowValue;
uniform float uShadowBleed;
uniform float uShadowFill;
uniform float uShadowStrength;

uniform float uTerm;
uniform float uBandSoft;
uniform float uBand2;
uniform float uCore;
uniform float uCoreSoft;

uniform float uSpec;
uniform float uSpecPow;
uniform vec3  uRimColor;
uniform float uRim;
uniform float uSkyBounce;

uniform float uGrain;
uniform float uGrainScale;
uniform float uGrainAlbedo;
uniform float uGrainShade;
uniform vec2  uGrainFade;
uniform sampler2D tGrain;

#ifdef TOON_MACRO
uniform float uMacro;
uniform float uMacroScale;
#endif

uniform vec3  uSSSColor;
uniform float uSSS;

uniform vec3  uEmissiveColor;
uniform float uEmissive;

uniform vec3  uLocalPos;
uniform vec3  uLocalCol;
uniform float uLocalRange;

#ifdef TOON_INGLOW
/* ( first y, last y, floor ) in OBJECT space — see TOON_INGLOW below */
uniform vec3  uGlowFade;
#endif

uniform float uAO;

#ifdef TOON_MAP
uniform sampler2D tMap;
#endif
#ifdef TOON_ALPHATEST
uniform float uAlphaTest;
#endif
#if defined( TOON_PLASTER ) || defined( TOON_WOOD )
uniform vec3 uTint2;
#endif
#ifdef TOON_PLASTER
uniform sampler2D tPlaster;
uniform vec3  uEdgeColor;
uniform float uVariation;
uniform float uVarScale;
uniform float uEdgeWear;
uniform float uRelief;
#endif
#ifdef TOON_WOOD
uniform sampler2D tWood;
uniform vec3  uWoodAxis;
uniform vec3  uWoodPerp;
uniform float uWoodScale;
uniform float uWoodAmt;
#endif

varying vec3  vWorldPos;
varying vec3  vWorldNormal;
varying vec3  vViewDir;
varying float vViewZ;
varying vec3  vObjPos;
varying vec3  vObjNormal;
varying vec2  vUvT;

void main() {
  vec4 tex = vec4( diffuse, opacity );

  #ifdef TOON_MAP
    tex *= texture2D( tMap, vUvT );
  #endif
  #ifdef USE_COLOR_ALPHA
    tex *= vColor;
  #elif defined( USE_COLOR )
    tex.rgb *= vColor;
  #endif
  #ifdef TOON_ALPHATEST
    if ( tex.a < uAlphaTest ) discard;
  #endif

  vec3 N = normalize( vWorldNormal );
  #ifdef DOUBLE_SIDED
    if ( ! gl_FrontFacing ) N = - N;
  #endif
  vec3 V = normalize( vViewDir );
  float dist = length( vViewDir );
  vec3 tw = wTriWeights( normalize( vObjNormal ) );
  vec3 gp = vObjPos;

  /* Surface detail fades out with distance so the grain never aliases
     into sparkle. It is a *material* LOD, not a post effect. */
  float lod = 1.0 - smoothstep( uGrainFade.x, uGrainFade.y, dist );

  vec3 up0 = abs( N.y ) < 0.985 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 T0 = normalize( cross( up0, N ) );
  vec3 B0 = cross( N, T0 );

  /* ---------------- painted plaster (§5.2) ----------------
     The tint2 break used to be smoothstep( 0.56, 1.0, blot ): blot is
     an fBm that lives almost entirely inside 0.30-0.65, so the second
     tone fired on a few per cent of the surface at a few per cent
     strength and every large plaster surface in the game — including
     the ground, which is the biggest one in any frame — rendered as a
     single flat fill with grain on it. Pivoting at the field's own
     mean and narrowing the edge makes it a real two-tone PATCH with a
     crisp boundary, which is what §2.1's grassLit/grassShade pair and
     §5.2's "colour variation blotching" both describe. */
  /* Texture relief is accumulated here and applied to the SHADING
     normal only, further down. It must not reach the normal the ramp
     reads: it is a high-frequency field, the bands are thresholds, and
     a threshold on a noisy normal is per-pixel speckle. That is not a
     theoretical worry — with the terminator narrowed to §2.2's 0.06
     the plaster relief (±0.21 of tilt, i.e. ±0.15 of N·L against a
     0.09-wide core step) turned the whole mid-distance ground into
     dirty green static. Real metre-scale form still bends the ramp;
     that is what the macro slope below is for. */
  vec3 nDetail = vec3( 0.0 );

  #ifdef TOON_PLASTER
    vec3 pl = wTriplanar( tPlaster, gp * uVarScale, tw );
    tex.rgb *= 0.895 + 0.215 * pl.r;
    tex.rgb = mix( tex.rgb, uTint2, smoothstep( 0.47, 0.55, pl.r ) * uVariation );
    nDetail += ( T0 * ( pl.g - 0.5 ) + B0 * ( pl.b - 0.5 ) ) * uRelief * lod;
  #endif

  /* ---------------- weathered wood (§5.3) ---------------- */
  #ifdef TOON_WOOD
    vec2 wuv = vec2( dot( gp, uWoodPerp ), dot( gp, uWoodAxis ) * 0.085 ) * uWoodScale;
    vec3 wd = texture2D( tWood, wuv ).rgb;
    tex.rgb *= mix( vec3( 1.0 ), vec3( wd.r * 0.92 + 0.34 ), uWoodAmt );
    tex.rgb = mix( tex.rgb, uTint2, smoothstep( 0.72, 1.0, 1.0 - wd.r ) * uWoodAmt * 0.5 );
    nDetail += ( T0 * ( wd.g - 0.5 ) + B0 * ( wd.b - 0.5 ) ) * uWoodAmt * 0.42 * lod;
  #endif

  /* ---------------- velvet grain (§1.2) ----------------
     Nsm keeps the modelled surface — including plaster and wood
     relief, which are real form and should bend the ramp — while N
     carries the grain on top.

     The grain perturbs the normal by ±0.27, which is more than twice
     the width of the whole terminator. Feeding that straight into the
     ramp dissolved the band into noise: clay came out as one
     continuous gradient with sparkle on it, which is exactly what a
     cel shader must not look like. So the band is taken from Nsm and
     the grain is re-applied below as a luminance modulation. Same
     velvet, and the two-band structure survives it. */
  /* ---------------- macro slope ----------------
     THE RAMP CANNOT BAND A SURFACE THAT HAS ONE NORMAL. Every band in
     this shader is a threshold on N·L, so a large flat plane — the
     ground, a wall, a dock — lands wholly inside one band and renders
     as a single lit fill next to clay forms that band beautifully. All
     the surface detail we had was either faded out by the lod term
     past 18 m or too high-frequency to move N.L across a threshold.

     This is a very low-frequency tilt of the SHADING normal, in world
     space, at no texture cost and with no distance fade: a metre-scale
     undulation that pushes N.L back and forth across the core step,
     and on surfaces angled away from the key across the terminator,
     so a Wind Waker ground reads as sculpted bands of light rather
     than as one flat green field.
     World space rather than object space so neighbouring terrain
     tiles, or a plane and the props standing on it, share one
     continuous field and never seam. */
  #ifdef TOON_MACRO
    vec2 ms = wMacroSlope( vWorldPos, uMacroScale );
    /* Ground undulates; a built wall is flat because someone built it
       flat. Weighting by how horizontal the surface is lets one default
       serve terrain (which needs a lot) and stucco (which needs a
       hint) without the world module having to know the difference. */
    float mk = mix( 0.30, 1.0, smoothstep( 0.30, 0.86, abs( N.y ) ) );
    /* Band-crossing detail has to be band-limited or it aliases, and a
       ground plane at grazing incidence is the worst case in the game:
       one pixel there spans metres. The field's finest lobe is
       1.46 / uMacroScale metres across, so fade the whole slope out as
       a pixel's world footprint approaches half of that. Without this
       the horizon fizzes. */
    float mfw = max( fwidth( vWorldPos.x ), fwidth( vWorldPos.z ) );
    float mf = 1.0 - smoothstep( 0.40 / uMacroScale, 1.35 / uMacroScale, mfw );
    N = normalize( N + ( T0 * ms.x + B0 * ms.y ) * uMacro * mk * mf );
  #endif

  /* The ramp reads FORM ONLY: geometry plus the metre-scale macro
     slope. Texture relief and grain ride on N from here down, where
     they light the surface without being able to shatter a band. */
  vec3 Nsm = N;
  N = normalize( N + nDetail );

  #ifdef TOON_GRAIN
    vec3 gr = wTriplanar( tGrain, gp * uGrainScale, tw );
    N = normalize( N + ( T0 * ( gr.x - 0.5 ) + B0 * ( gr.y - 0.5 ) ) * ( uGrain * 34.0 ) * lod );
    tex.rgb *= 1.0 + ( gr.z - 0.5 ) * uGrainAlbedo * lod;
  #endif

  vec3 albedo = tex.rgb;

  #ifdef TOON_EMISSIVE
    /* Lamps, windows and glints: mostly self-lit, with a soft fresnel
       lift at the edges so a glowing sphere still reads as a sphere.
       Pushed well above 1.0 on purpose — bloom's prefilter threshold
       is 1.7 in linear HDR (postfx.js) and emissives are now the only
       thing in the world that crosses it, so they own the whole
       highlight-bloom budget. */
    float fr = 1.0 - max( dot( N, V ), 0.0 );
    vec3 col = albedo * uEmissiveColor * uEmissive * ( 0.82 + 0.55 * fr * fr );
    col += uAmbSky * uAmbIntensity * 0.25 * albedo;
  #else

  /* ---------------- key light ---------------- */
  vec3 L = normalize( uSunDir );
  float ndl  = dot( Nsm, L );        // drives the ramp
  float ndlG = dot( N, L );          // grained, for velvet + specular
  float rot = wHash12( gl_FragCoord.xy ) * 6.2831853;
  float sh = mix( 1.0, wCsmShadow( vViewZ, rot ), uShadowStrength );

  /* Two bands, soft-stepped — never a hard step (§2.2). uBandSoft is
     the HALF width of the terminator, so the 0.055 default spans
     ~0.11 of ndl: narrow enough that the boundary genuinely reads as
     a band, wide enough that it never stair-steps. */
  float band = smoothstep( uTerm - uBandSoft, uTerm + uBandSoft, ndl );
  float litK = band * sh;

  /* Ambient: sky above, ground bounce below. Normalised to unit
     luminance and then only partly re-saturated, because the blue in
     a shadow has to come from ONE place. Tinting the ambient AND
     applying the shadow law would double-count it and every shadow in
     the game would go teal. */
  vec3 ambHue = mix( uAmbGround, uAmbSky, N.y * 0.5 + 0.5 );
  ambHue /= max( dot( ambHue, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 );
  vec3 amb = mix( vec3( 1.0 ), ambHue, uAmbSat ) * uAmbIntensity;
  amb += ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
      amb += getHemisphereLightIrradiance( hemisphereLights[ i ], N );
    }
    #pragma unroll_loop_end
  #endif

  /* THE LAW (§2.1). The two ends of the ramp are two *colours*, not
     one colour at two brightnesses: the shade end is the lit end put
     through wShadeLaw(). Because the CSM term lives inside litK, a
     cast shadow and a terminator are the same operation and can never
     disagree about hue — which is the whole point.

     The old form here multiplied a linear-space tint into the albedo
     AND multiplied that by a dark ambient. Two value drops, no real
     hue rotation, so every shadow came out a desaturated copy of its
     surface. Grass in shade stayed green. */
  vec3 key = uSunColor * uSunIntensity;
  vec3 litCol   = albedo * ( key + amb );
  vec3 shadeCol = wShadeLaw( litCol, uShadowTint, uShadowAmount, uShadowValue,
                             uShadowBleed, uShadowFill );
  vec3 col = mix( shadeCol, litCol, litK );

  /* Third tone: a brighter band toward the light core. Two bands is
     the law, but Wind Waker's sculpted forms carry a third step where
     the surface turns fully into the key, and without it a sphere
     still reads as a disc. */
  float core = smoothstep( uCore - uCoreSoft, uCore + uCoreSoft, ndl ) * litK;
  col *= 1.0 + core * uBand2;

  /* The velvet, re-applied as luminance rather than as a ramp input.
     Half of it is the grain's real effect on N·L; the other half is
     the pore height itself, because the tangent-plane tilt is very
     nearly orthogonal to L exactly where the surface faces the key —
     a velvet routed only through N·L vanishes in the light, which is
     the one place clay has to look powdery. */
  #ifdef TOON_GRAIN
    float gv = ( ndlG - ndl ) * 1.8 + ( gr.z - 0.5 ) * 0.8;
    col *= 1.0 + gv * uGrainShade * ( 0.36 + 0.64 * litK );
  #endif

  /* ---------------- specular ----------------
     One broad, faint sheen. On clay this is the 8% cranium catch from
     §1.2 — if you can see a distinct bright dot it is too strong. */
  vec3 Hv = normalize( L + V );
  float sp = pow( max( dot( N, Hv ), 0.0 ), uSpecPow );
  #ifdef TOON_SPEC_BANDED
    sp = floor( sp * 3.0 + 0.4 ) / 3.0;
  #else
    sp = smoothstep( 0.015, 0.85, sp );
  #endif
  col += key * sp * uSpec * litK;

  /* ---------------- rim + sky bounce ----------------
     Both read the smooth normal: a rim is a silhouette effect and
     grain along an edge only makes it crawl. */
  float fres = 1.0 - max( dot( Nsm, V ), 0.0 );
  if ( uRim > 0.0 ) {
    float rim = smoothstep( 0.72, 0.99, fres ) * ( 0.22 + 0.78 * smoothstep( -0.30, 0.55, ndl ) );
    col += uRimColor * rim * uRim * ( 0.30 + 0.70 * sh );
  }
  col += uAmbSky * uAmbIntensity * uSkyBounce
       * smoothstep( -0.2, 0.92, Nsm.y ) * ( 0.28 + 0.72 * fres * fres );

  /* ---------------- subsurface ----------------
     Thin parts pick up a warm transmission; the terminator gets a
     narrow warm bleed. That bleed is most of why clay reads as clay
     and not as painted plastic. */
  #ifdef TOON_SSS
    float back = pow( max( dot( V, - L ), 0.0 ), 2.6 );
    col += uSSSColor * key * back * uSSS * ( 0.32 + 0.68 * sh );
    float termW = max( uBandSoft, 0.05 );
    float term = smoothstep( uTerm + termW * 1.1, uTerm - termW * 1.6, ndl )
               * smoothstep( uTerm - termW * 3.4, uTerm - termW * 0.8, ndl );
    col += uSSSColor * albedo * term * uSSS * 1.15 * sh * uSunIntensity * 0.35;
  #endif

  /* ---------------- the one local light ----------------
     A warm source close to the surface, banded like the key so it
     belongs to the same drawing rather than arriving as a smooth
     photographic falloff. The wrap term matters more than the band
     does: this exists for a burner inside a seven-metre envelope,
     which is a very large soft source at a very short range, and a
     hard N.L on that reads as a torch. Squared attenuation, zero at
     uLocalRange, so nothing has an edge.

     Guarded on the colour, not the distance: the branch is uniform,
     so a draw either pays for all of this or for none of it, and with
     nothing alight it is one compare per fragment. */
  if ( uLocalCol.r + uLocalCol.g + uLocalCol.b > 0.0 ) {
    vec3 Lv = uLocalPos - vWorldPos;
    float ld = length( Lv );
    float att = max( 0.0, 1.0 - ld / uLocalRange );
    att *= att;
    float lnl = dot( Nsm, Lv / max( ld, 1e-4 ) );
    float lb = smoothstep( -0.25, 0.42, lnl );
    col += albedo * uLocalCol * att * ( 0.22 + 0.78 * lb );
  }

  #ifdef TOON_INGLOW
    /* LIT FROM INSIDE, AND FALLING OFF THE WAY A LAMP IN A BAG DOES.
       A flat emissive add over a whole envelope is a paint job: it
       lifts the crown and the skirt by the same amount, which flattens
       the very form the gores and the load tapes exist to describe.
       The real thing is a burner at the mouth, so the fabric nearest
       the throat is several times brighter than the crown, and the
       gradient is in OBJECT space (uGlowFade is y at the throat, y
       where it has died, and the floor it dies to) so it rides the
       envelope's own lean and inflation without a single per-frame
       write. Multiplied by the albedo, unlike the plain emissive
       below, because a lit envelope shows its OWN livery — that is
       what makes an inflated balloon at dusk read as orange and cream
       panels rather than as one amber lamp. */
    float eg = 1.0 - smoothstep( uGlowFade.x, uGlowFade.y, vObjPos.y );
    col += albedo * uEmissiveColor * uEmissive * mix( uGlowFade.z, 1.0, eg * eg );
  #else
    col += uEmissiveColor * uEmissive;
  #endif

  #endif  // TOON_EMISSIVE

  /* baked AO rides in the vertex colour alpha when a module bakes it */
  #ifdef USE_COLOR_ALPHA
    col *= mix( vec3( 0.62, 0.575, 0.565 ), vec3( 1.0 ), mix( 1.0, vColor.a, uAO ) );
  #endif

  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    col = mix( col, fogColor, fogFactor );
  #endif

  gl_FragColor = vec4( col, tex.a );
}
`;

  /* ================================================================
     Outline — inverted hull (§2.2)
     ================================================================ */
  const OUTLINE_VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>
#include <fog_pars_vertex>
#ifdef TOON_WIND
${WIND_GLSL}
uniform float uWindWeight;
uniform float uWindPhase;
uniform vec2  uWindHeight;
#endif
uniform float uWidthPx;
uniform vec2  uOutlineRes;     // drawing buffer size in pixels
uniform float uOutlineScale;   // global trim
uniform vec3  uOutlineFade;    // ( near m, far m, width scale at far )
varying float vOutFade;
#ifdef TOON_HULLN
attribute vec3 aHullN;
#endif
#ifdef TOON_ALPHATEST
uniform vec2 uUvScale;
varying vec2 vUvT;
#endif
varying float vHullZ;
void main() {
  #include <batching_vertex>
  #include <beginnormal_vertex>

  /* Expand along a *smoothed* normal. A box's face normals are split
     per face, so expanding along them tears the hull into six
     disjoint slabs and the outline breaks apart at every corner.
     aHullN is the same geometry's normals averaged by position. */
  #ifdef TOON_HULLN
    objectNormal = aHullN;
  #endif

  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>

  /* three defines FLIP_SIDED for every BackSide material, and
     <defaultnormal_vertex> negates the normal when it is set. The
     hull therefore expanded *inward* and the entire outline pass has
     been silently drawing itself inside the mesh it outlines. Undo
     it: we want the geometric outward normal, side is irrelevant. */
  #ifdef FLIP_SIDED
    transformedNormal = - transformedNormal;
  #endif

  #include <begin_vertex>
  #include <skinning_vertex>

  vec4 wp = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    wp = batchingMatrix * wp;
  #endif
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;

  #ifdef TOON_WIND
    float wH = clamp( ( position.y - uWindHeight.x ) * uWindHeight.y, 0.0, 1.0 );
    float wPh = uWindPhase + dot( wp.xz, vec2( 0.71, 0.43 ) );
    wp.xyz += windOffset( wp.xyz, wH * uWindWeight, wPh );
  #endif

  vec4 mvPosition = viewMatrix * wp;

  /* A card's hull is coplanar with the card it outlines, so without a
     nudge the two z-fight into stripes. Push the hull one hair further
     from the camera; solid hulls separate themselves. */
  #ifdef TOON_ALPHATEST
    mvPosition.z -= max( 0.0025, - mvPosition.z * 0.0016 );
    vUvT = uv * uUvScale;
  #endif

  vec4 clip = projectionMatrix * mvPosition;

  /* THE HULL IS EXPANDED IN SCREEN SPACE, NOT IN VIEW SPACE.
     §2.2 asks for a stroke that stays ~1.6 px wide. Displacing the
     vertex along its view-space normal only delivers that when the
     normal happens to lie in the screen plane: the delivered width is
     w * sin(angle between the normal and the view ray), and on a
     pyramid roof, whose silhouette is a ridge whose vertex normals
     bisect two faces and lean out of the screen, that factor measured
     about 1/6 — the roof's whole sky-facing edge had no visible line
     on it while a box beside it, whose corner normals sit at a
     convenient 45 degrees, drew a clean one. Projecting the normal to
     the near plane and stepping a fixed number of *pixels* along it
     makes the width exactly uWidthPx for every silhouette in the
     frame, at every distance, with no per-shape luck involved. */
  /* The screen direction of a view-space offset is NOT
     (projectionMatrix * vec4(n,0)).xy — that drops the perspective
     divide's own derivative, which is the dominant term anywhere off
     the optical axis. Take the difference of two projected points
     instead; it is two extra multiplies and it is exact. */
  vec3 nv = normalize( transformedNormal );
  float eps = 0.002 * max( - mvPosition.z, 0.05 );
  vec4 clipN = projectionMatrix * vec4( mvPosition.xyz + nv * eps, 1.0 );
  vec2 d = ( clipN.xy / clipN.w - clip.xy / clip.w ) * uOutlineRes;
  float dl = length( d );
  /* dl -> 0 only where the normal points straight down the view ray,
     which is never a silhouette; those verts stay put inside the mesh. */
  d = dl > 1e-6 ? d / dl : vec2( 0.0 );

  /* DISTANCE FALLOFF. The screen-space expansion above already holds
     the stroke at a constant *pixel* width whatever the distance,
     which is what §2.2 asks for, so this envelope only ever trims —
     and it must trim late. Set too near it deletes the linework from
     every frame that is not a close-up: the whole mid-ground of a
     vista drops sub-pixel and the city reads under-drawn.
     uOutlineFade.x therefore sits at §2.4's 120 m haze onset, so the
     thing that retires the stroke is the same thing that retires the
     surface it is drawn around, and the colour retires with it (see
     the fragment shader) toward the surface's own shade rather than
     popping out of existence. */
  float outDist = - mvPosition.z;
  vOutFade = 1.0 - smoothstep( uOutlineFade.x, uOutlineFade.y, outDist );
  float wpx = uWidthPx * uOutlineScale * mix( uOutlineFade.z, 1.0, vOutFade );
  clip.xy += d * wpx * 2.0 / uOutlineRes * clip.w;

  vHullZ = - mvPosition.z;
  gl_Position = clip;
  #include <fog_vertex>
}
`;

  /* The prepass variant of the hull. THE OUTLINE HAS TO EXIST IN THE
     DEPTH BUFFER. Hulls used to be hidden during the depth+normal
     prepass — reasonable, since a back-faced shell a hair outside the
     surface would poison SSAO — but the consequence was that every
     stroke pixel carried the depth of whatever was *behind* it. Where
     that was sky, the prepass read z = 0, the composite read "infinitely
     far", and the far-field DOF replaced the stroke with a wide blur of
     its own neighbourhood. Every silhouette against the sky lost its
     outline, which in a Wind Waker frame is most of the ones that
     matter. Rendering the hull into the prepass with its own expansion
     gives the stroke the object's depth, so DOF leaves it alone.
     The normal is written camera-facing rather than as the far-side
     geometric normal: a two-pixel sliver should contribute no AO of its
     own, and a backward-facing normal there would fringe it. */
  const OUTLINE_ND_FRAG = /* glsl */`
#ifdef TOON_ALPHATEST
uniform sampler2D tMap;
uniform float uAlphaTest;
varying vec2 vUvT;
#endif
varying float vHullZ;
void main() {
  #ifdef TOON_ALPHATEST
    if ( texture2D( tMap, vUvT ).a < uAlphaTest ) discard;
  #endif
  gl_FragColor = vec4( 0.5, 0.5, 1.0, vHullZ );
}
`;

  const OUTLINE_FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform vec3 uColorFar;
varying float vOutFade;
#ifdef TOON_ALPHATEST
uniform sampler2D tMap;
uniform float uAlphaTest;
varying vec2 vUvT;
#endif
void main() {
  #ifdef TOON_ALPHATEST
    if ( texture2D( tMap, vUvT ).a < uAlphaTest ) discard;
  #endif
  /* uColorFar is the same albedo taken barely into shade, so a stroke
     that has thinned to a fraction of a pixel is also the colour of
     the thing it is drawn around: no line pops off, nothing at range
     reads as ink, and there is no visible boundary where the falloff
     happens. */
  vec3 col = mix( uColorFar, uColor, vOutFade );
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    col = mix( col, fogColor, fogFactor );
  #endif
  gl_FragColor = vec4( col, 1.0 );
}
`;

  /* Depth material for wind/alpha-tested surfaces, so a swaying
     canopy casts a swaying shadow instead of a rigid one. */
  const DEPTH_FRAG = /* glsl */`
#include <common>
#include <packing>
#ifdef TOON_ALPHATEST
uniform sampler2D tMap;
uniform float uAlphaTest;
varying vec2 vUvT;
#endif
varying vec2 vHiZW;
void main() {
  #ifdef TOON_ALPHATEST
    if ( texture2D( tMap, vUvT ).a < uAlphaTest ) discard;
  #endif
  float fragCoordZ = 0.5 * vHiZW[ 0 ] / vHiZW[ 1 ] + 0.5;
  gl_FragColor = packDepthToRGBA( fragCoordZ );
}
`;

  const DEPTH_VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>
#ifdef TOON_WIND
${WIND_GLSL}
uniform float uWindWeight;
uniform float uWindPhase;
uniform vec2  uWindHeight;
#endif
#ifdef TOON_ALPHATEST
uniform vec2 uUvScale;
varying vec2 vUvT;
#endif
varying vec2 vHiZW;
void main() {
  #ifdef TOON_ALPHATEST
    vUvT = uv * uUvScale;
  #endif
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 wp = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    wp = batchingMatrix * wp;
  #endif
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;
  #ifdef TOON_WIND
    float wH = clamp( ( position.y - uWindHeight.x ) * uWindHeight.y, 0.0, 1.0 );
    float wPh = uWindPhase + dot( wp.xz, vec2( 0.71, 0.43 ) );
    wp.xyz += windOffset( wp.xyz, wH * uWindWeight, wPh );
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
  vHiZW = gl_Position.zw;
}
`;

  /* ================================================================
     Material construction
     ================================================================ */
  const allMaterials = new Set();
  const pendingWind = [];
  const _dbs = new THREE.Vector2();

  function attachWind(m) {
    if (ctx.wind) ctx.wind.attach(m);
    else pendingWind.push(m);
  }

  const DEFAULTS = {
    color: 0xffffff,
    opacity: 1,
    transparent: false,
    side: THREE.FrontSide,
    depthWrite: true,

    /* §2.2: "smoothstep over ~0.06 of the terminator, not a hard
       step". bandSoft is the HALF width, so this is 0.03, not 0.06 —
       the previous reading spent 0.11 of ndl on the terminator, which
       on a 250 px clay sphere is a 15 px feather, and 15 px is not a
       cel edge, it is a gradient. Everything in this file that widens
       a band has to be measured against that: a band you cannot find
       in a pixel profile is not a band. */
    term: 0.14,
    bandSoft: 0.030,
    band2: 0.14,
    core: 0.55,
    coreSoft: 0.055,

    spec: 0.10,
    specPow: 26,
    specBanded: false,

    rim: 0.42,
    rimColor: null,
    skyBounce: 0.10,

    /* metre-scale undulation of the shading normal — what makes a
       large flat surface band. See TOON_MACRO in the fragment shader.
       macroScale is in cycles per metre; 0.16 puts the coarsest lobe
       at ~6 m, which is the size Wind Waker's ground patches read at. */
    macro: 0,
    macroScale: 0.16,

    grain: 0,
    grainScale: 3.4,
    grainAlbedo: 0.10,
    grainShade: 0.55,
    grainFade: [18, 80],

    sss: 0,
    sssColor: CLAY.sss,

    shadowTint: null,
    shadowAmount: null,
    shadowValue: null,
    shadowBleed: null,
    shadowFill: null,
    shadowStrength: 1.0,

    emissive: 0,
    emissiveColor: 0xffffff,
    /* [ y at full strength, y where it has gone, the floor it goes to ]
       in object space. Opts the material into TOON_INGLOW. */
    inGlow: null,
    ao: 1.0,

    map: null,
    uvScale: [1, 1],
    alphaTest: 0,

    wind: 0,
    windBase: 0,
    windHeight: 1,
    windPhase: 0,

    outline: false,
    /* §2.2 asks for ~1.6 px on screen, and since the hull expands in
       screen space (OUTLINE_VERT) this number now *is* the delivered
       width rather than an upper bound that geometry chips away at.
       §2.2's 1.6 px is what survives to the eye, not what the hull is
       told to draw. Three passes eat into it after the forward pass:
       DOF blurs any stroke that is not exactly at the focus plane,
       FXAA spends roughly half a pixel blending the edge, and the
       grade lifts it toward its neighbours. Measured at a nominal 2.2
       the delivered stroke was one 8-bit pixel on a roofline and
       nothing at all on a post or a crate at 1400x900 — "barely
       perceptible", which is the same failure as no outline. 3.8
       measured a clean 2.5 px of stroke on the crate at 1400x900 and
       was starting to look inked; 3.2-3.4 is that one notch back, and
       delivers a line you can read at 1:1 without hunting for it. */
    outlineWidth: 3.2,
    noOutline: false,

    vertexColors: false,
    name: 'toon',
  };

  function buildUniforms(o) {
    const u = {
      diffuse: { value: toColor(o.color) },
      opacity: { value: o.opacity },

      uSunDir: globals.uSunDir,
      uSunColor: globals.uSunColor,
      uSunIntensity: globals.uSunIntensity,
      uAmbSky: globals.uAmbSky,
      uAmbGround: globals.uAmbGround,
      uAmbIntensity: globals.uAmbIntensity,
      uAmbSat: globals.uAmbSat,
      uShadowTint: o.shadowTint ? { value: toColor(o.shadowTint) } : globals.uShadowTint,
      uShadowAmount: o.shadowAmount != null ? { value: o.shadowAmount } : globals.uShadowAmount,
      uShadowValue: o.shadowValue != null ? { value: o.shadowValue } : globals.uShadowValue,
      uShadowBleed: o.shadowBleed != null ? { value: o.shadowBleed } : globals.uShadowBleed,
      uShadowFill: o.shadowFill != null ? { value: o.shadowFill } : globals.uShadowFill,
      uShadowStrength: { value: o.shadowStrength },

      uTerm: { value: o.term },
      uBandSoft: { value: o.bandSoft },
      uBand2: { value: o.band2 },
      uCore: { value: o.core },
      uCoreSoft: { value: o.coreSoft },

      uSpec: { value: o.spec },
      uSpecPow: { value: o.specPow },
      uRimColor: o.rimColor ? { value: toColor(o.rimColor) } : globals.uRimColor,
      uRim: { value: o.rim },
      uSkyBounce: { value: o.skyBounce },

      uMacro: { value: o.macro },
      uMacroScale: { value: o.macroScale },

      uGrain: { value: o.grain },
      uGrainScale: { value: o.grainScale },
      uGrainAlbedo: { value: o.grainAlbedo },
      uGrainShade: { value: o.grainShade },
      uGrainFade: { value: new THREE.Vector2(o.grainFade[0], o.grainFade[1]) },
      tGrain: globals.tGrain,

      uSSSColor: { value: toColor(o.sssColor) },
      uSSS: { value: o.sss },

      uEmissiveColor: { value: toColor(o.emissiveColor) },
      uEmissive: { value: o.emissive },
      uAO: { value: o.ao },

      /* shared by reference, so setLocalLight() moves every surface in
         the game with three writes and no per-material walk */
      uLocalPos: globals.uLocalPos,
      uLocalCol: globals.uLocalCol,
      uLocalRange: globals.uLocalRange,

      uUvScale: { value: new THREE.Vector2(o.uvScale[0], o.uvScale[1]) },
    };

    if (o.inGlow) {
      u.uGlowFade = { value: new THREE.Vector3(o.inGlow[0], o.inGlow[1], o.inGlow[2] ?? 0.15) };
    }
    if (o.map) u.tMap = { value: o.map };
    if (o.alphaTest > 0) u.uAlphaTest = { value: o.alphaTest };

    if (o.plaster) {
      u.tPlaster = globals.tPlaster;
      u.uTint2 = { value: toColor(o.tint2 ?? o.color) };
      u.uEdgeColor = { value: toColor(o.edgeColor ?? 0xffffff) };
      u.uVariation = { value: o.variation ?? 0.16 };
      u.uVarScale = { value: o.varScale ?? 0.35 };
      u.uEdgeWear = { value: o.edgeWear ?? 0.25 };
      u.uRelief = { value: o.relief ?? 0.22 };
    }
    if (o.wood) {
      u.tWood = globals.tWood;
      const ax = new THREE.Vector3().fromArray(o.grainDir ?? [0, 1, 0]).normalize();
      const perp = new THREE.Vector3(0.13, 0.79, 0.6).cross(ax);
      if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
      perp.normalize();
      u.uWoodAxis = { value: ax };
      u.uWoodPerp = { value: perp };
      u.uWoodScale = { value: o.woodScale ?? 0.55 };
      u.uWoodAmt = { value: o.woodAmount ?? 0.85 };
      u.uTint2 = { value: toColor(o.tint2 ?? BUILD.woodDark) };
    }
    if (o.wind > 0) {
      u.uWindWeight = { value: o.wind };
      u.uWindPhase = { value: o.windPhase };
      u.uWindHeight = { value: new THREE.Vector2(o.windBase, 1 / Math.max(0.001, o.windHeight)) };
    }
    return u;
  }

  function buildDefines(o) {
    const d = {};
    if (o.grain > 0) d.TOON_GRAIN = '';
    if (o.macro > 0) d.TOON_MACRO = '';
    if (o.plaster) d.TOON_PLASTER = '';
    if (o.wood) d.TOON_WOOD = '';
    if (o.sss > 0) d.TOON_SSS = '';
    if (o.map) d.TOON_MAP = '';
    if (o.alphaTest > 0) d.TOON_ALPHATEST = '';
    if (o.wind > 0) d.TOON_WIND = '';
    if (o.specBanded) d.TOON_SPEC_BANDED = '';
    if (o.emissiveOnly) d.TOON_EMISSIVE = '';
    if (o.inGlow) d.TOON_INGLOW = '';
    return d;
  }

  /* ---- the base factory ---- */
  function toon(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const defines = buildDefines(o);

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      THREE.UniformsLib.fog,
    ]);
    Object.assign(uniforms, buildUniforms(o));
    if (globals.uCsmSplits) {
      uniforms.uCsmSplits = globals.uCsmSplits;
      uniforms.uCsmBlur = globals.uCsmBlur;
      uniforms.uCsmFade = globals.uCsmFade;
    }

    const m = new THREE.ShaderMaterial({
      name: o.name,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      defines,
      lights: true,
      fog: true,
      side: o.side,
      transparent: o.transparent,
      depthWrite: o.depthWrite,
      vertexColors: o.vertexColors,
    });
    m.userData.wally = o;
    m.userData.noOutline = !!o.noOutline;
    m.userData.wantsOutline = !!o.outline;
    m.userData.outlineWidth = o.outlineWidth;

    if (o.wind > 0) attachWind(m);

    /* Prepass + shadow variants for anything that displaces or
       discards, so AO, DOF and shadows all see the same silhouette. */
    if (o.wind > 0 || o.alphaTest > 0) {
      m.userData.ndMaterial = makeND(o, defines, uniforms);
      m.userData.depthMaterial = makeDepth(o, defines, uniforms);
    }

    allMaterials.add(m);
    return m;
  }

  function makeND(o, defines, srcUniforms) {
    const u = {
      uUvScale: srcUniforms.uUvScale,
    };
    const d = {};
    if (defines.TOON_WIND !== undefined) {
      d.TOON_WIND = '';
      u.uWindWeight = srcUniforms.uWindWeight;
      u.uWindPhase = srcUniforms.uWindPhase;
      u.uWindHeight = srcUniforms.uWindHeight;
    }
    if (defines.TOON_ALPHATEST !== undefined) {
      d.TOON_ALPHATEST = '';
      u.tMap = srcUniforms.tMap;
      u.uAlphaTest = srcUniforms.uAlphaTest;
    }
    const m = new THREE.ShaderMaterial({
      name: o.name + '.nd',
      defines: d,
      uniforms: u,
      side: o.side,
      vertexShader: /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>
${defines.TOON_WIND !== undefined ? WIND_GLSL + `
uniform float uWindWeight; uniform float uWindPhase; uniform vec2 uWindHeight;` : ''}
uniform vec2 uUvScale;
varying vec3 vN;
varying float vZ;
varying vec2 vUvT;
void main() {
  vUvT = uv * uUvScale;
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 wp = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    wp = batchingMatrix * wp;
  #endif
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;
  #ifdef TOON_WIND
    float wH = clamp( ( position.y - uWindHeight.x ) * uWindHeight.y, 0.0, 1.0 );
    float wPh = uWindPhase + dot( wp.xz, vec2( 0.71, 0.43 ) );
    wp.xyz += windOffset( wp.xyz, wH * uWindWeight, wPh );
  #endif
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  vN = normalize( transformedNormal );
  vZ = - mvPosition.z;
}
`,
      fragmentShader: /* glsl */`
#ifdef TOON_ALPHATEST
uniform sampler2D tMap;
uniform float uAlphaTest;
#endif
varying vec3 vN;
varying float vZ;
varying vec2 vUvT;
void main() {
  #ifdef TOON_ALPHATEST
    if ( texture2D( tMap, vUvT ).a < uAlphaTest ) discard;
  #endif
  gl_FragColor = vec4( normalize( vN ) * 0.5 + 0.5, vZ );
}
`,
    });
    allMaterials.add(m);
    return m;
  }

  function makeDepth(o, defines, srcUniforms) {
    const u = {};
    const d = {};
    if (defines.TOON_WIND !== undefined) {
      d.TOON_WIND = '';
      u.uWindWeight = srcUniforms.uWindWeight;
      u.uWindPhase = srcUniforms.uWindPhase;
      u.uWindHeight = srcUniforms.uWindHeight;
    }
    if (defines.TOON_ALPHATEST !== undefined) {
      d.TOON_ALPHATEST = '';
      u.tMap = srcUniforms.tMap;
      u.uAlphaTest = srcUniforms.uAlphaTest;
      u.uUvScale = srcUniforms.uUvScale;
    }
    const m = new THREE.ShaderMaterial({
      name: o.name + '.depth',
      defines: d,
      uniforms: u,
      side: o.side,
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
    });
    if (defines.TOON_WIND !== undefined) attachWind(m);
    allMaterials.add(m);
    return m;
  }

  /* ================================================================
     The five world materials (§5) + emissive
     ================================================================ */

  /* WARM SHADE — §1.2 vs §2.1.
     The blue-violet shadow law is the WORLD's law. §1.2 is explicit
     that Wally's creases are a soft *warm* grey (#A9A5A2 / #A9A9A8):
     he is a studio product render, and clay is the one material whose
     shade must not go blue. But clay standing in the world still has
     to sit in the world's light, so this is a dial rather than a
     switch: `warmShade` 0 = the full world law, 1 = §1.2's warm grey.

     Implemented by moving the material's own shade TINT, not by
     weakening the law — the terminator keeps its full strength and its
     softness, it just lands on warm grey instead of periwinkle. The
     blend is done on the hue-normalised tints because that is the form
     wShadeLaw() uses. */
  const _warmAO = srgb(SHADOW.ao);
  function warmShadeTint(k) {
    const norm = (c) => {
      const g = [c.r, c.g, c.b].map((v) => Math.pow(Math.max(v, 1e-5), 1 / 2.2));
      const m = Math.max(g[0], g[1], g[2]);
      return g.map((v) => v / m);
    };
    const a = norm(srgb(SHADOW.tint));
    const b = norm(_warmAO);
    const g = a.map((v, i) => lerp(v, b[i], k));
    return new THREE.Color(...g.map((v) => Math.pow(v, 2.2)));
  }

  /* 1. CLAY — characters. Matte, grained, soft wide AO, one broad 8%
     sheen, no outline, no rim. This is Wally's skin. */
  function clay(opts = {}) {
    const sss = opts.sss ?? 0.20;
    /* ctx.mat.clay({ warmShade: 0..1 }) — see warmShadeTint above.
       1.0 by default. Not a compromise value: the two tints are far
       apart, and anything below ~0.9 still leaves blue as the largest
       channel — Wally stays periwinkle right up until the blend
       finishes. At 1.0 the shade lands on #A9A8A6 against a #D3D3D2
       body, which is §1.2's deep AO crease to within a bit. Dial it
       down if he ever needs to sit in a strongly coloured light. */
    const warm = opts.warmShade ?? 1.0;
    return toon({
      shadowTint: opts.shadowTint ?? warmShadeTint(warm),
      name: 'clay',
      color: CLAY.body,
      /* §1.2 describes a studio product render lit by a large soft
         key, and Wally carries no outline — his form is read entirely
         through shading. So clay gets the softest terminator in the
         game, roughly twice the world default. It is still a *band*:
         at 0.46 (where this started) the smoothstep spanned more than
         the whole lit hemisphere and clay rendered as a plain lambert
         gradient with grain on top. */
      /* Where the terminator lands on the form is geometry, not
         taste: the band sits on the ring where N.L crosses this
         number, and with the lab key ~84 degrees off the view ray a
         term of 0.21 put that ring 15 % of the radius from the centre
         of the sphere and the core step at 0.49 R. 0.26/0.58 spreads
         the three tones evenly across the visible hemisphere, which is
         what makes a sphere read as a sphere without an outline. */
      term: 0.26,
      /* Clay gets the softest terminator in the game — a large soft
         studio key on a form with no outline — but soft is 0.034 of
         half width, i.e. ~5 px on a 250 px sphere. At 0.062 it spanned
         15 px and measured as a smooth gradient with grain on it,
         which is the one thing a cel shader must never look like. */
      bandSoft: 0.028,
      /* THE TERMINATOR HAS TO BE THE STRONGEST EDGE ON THE FORM. §1.2
         gives the three tones outright — lit cheek #DEDEDD, mid flank
         #CFCFCE, deep crease #A9A9A8 — so the core step is worth 5 %
         and the terminator 24 %. At 0.22 the core was as strong as the
         terminator and landed as a long straight chamfer across the
         sphere: the ball read as a cut gem rather than as clay. Clay is
         the one material where the third tone is a whisper. */
      band2: 0.08,
      core: 0.58,
      coreSoft: 0.075,
      /* roughness 0.92-0.96 -> a very broad, very faint sheen. If you
         can see a distinct bright dot it is too strong (§1.2). */
      spec: 0.085,
      specPow: 5.5,
      rim: 0.0,                 // NO rim light of any colour on clay
      skyBounce: 0.16,
      grain: opts.grain ?? 0.016,
      grainScale: 3.6,
      grainAlbedo: 0.085,
      grainFade: [14, 60],
      sss,
      sssColor: CLAY.sss,
      /* The law still applies, but on a warm tint the hue rotation is
         almost nothing, so the value drop is the whole terminator.
         0.90 was authored when clay shaded blue and the hue contrast
         did the reading; on warm grey it left no visible band at all.
         0.80 puts §1.2's #DEDEDD lit cheek against its #A9A9A8 crease,
         which is the ratio the reference render carries. */
      shadowAmount: 0.50,
      shadowValue: 0.80,
      shadowBleed: 0.14,
      shadowFill: 0.040,
      outline: false,
      noOutline: true,          // Wally may not be outlined (§1.2)
      ao: 1.0,
      ...opts,
    });
  }

  /* 2. PAINTED PLASTER — buildings. */
  function plaster(opts = {}) {
    return toon({
      name: 'plaster',
      color: BUILD.stucco,
      plaster: true,
      tint2: opts.tint2 ?? BUILD.stuccoAlt,
      edgeColor: opts.edgeColor ?? 0xfffaf0,
      variation: opts.variation ?? 0.18,
      varScale: opts.varScale ?? 0.30,
      edgeWear: opts.edgeWear ?? 0.28,
      relief: opts.relief ?? 0.24,
      /* on by default: plaster is what terrain, ground and every large
         wall in the city are made of, and those are exactly the
         surfaces the two-band ramp cannot band on its own */
      /* 0.40 tilted the shading normal by about 11 degrees, which on a
         ground plane whose N.L sits at 0.56-0.64 wiggles inside the
         core band without ever crossing it — measured, the 160 m plane
         came out as one flat fill with albedo blotching on it. It has
         to swing far enough to cross a threshold or it does nothing at
         all; callers that own a big horizontal surface push it further
         still (see the lab ground). */
      macro: opts.macro ?? 0.62,
      macroScale: opts.macroScale ?? 0.22,
      term: 0.15,
      bandSoft: 0.028,
      /* the core step is what the macro slope swings across, so on
         plaster it has to be worth seeing and it has to be a step */
      band2: 0.20,
      core: 0.56,
      coreSoft: 0.045,
      spec: 0.05,
      specPow: 20,
      rim: 0.40,
      skyBounce: 0.12,
      grain: 0.009,
      grainScale: 5.0,
      grainAlbedo: 0.07,
      outline: true,
      outlineWidth: 3.4,
      ...opts,
    });
  }

  /* 3. WEATHERED WOOD — docks, carts, signs. */
  function wood(opts = {}) {
    return toon({
      name: 'wood',
      color: BUILD.wood,
      wood: true,
      grainDir: opts.grainDir ?? [0, 1, 0],
      woodScale: opts.woodScale ?? 0.55,
      woodAmount: opts.woodAmount ?? 0.85,
      tint2: opts.tint2 ?? BUILD.woodDark,
      term: 0.15,
      bandSoft: 0.028,
      band2: 0.20,
      core: 0.56,
      coreSoft: 0.05,
      spec: 0.06,
      specPow: 16,
      rim: 0.36,
      skyBounce: 0.15,
      grain: 0.010,
      grainScale: 4.2,
      grainAlbedo: 0.09,
      outline: true,
      outlineWidth: 3.4,
      ...opts,
    });
  }

  /* 5. FOLIAGE — two-band flat, alpha-tested, wind-driven. */
  function foliage(opts = {}) {
    const map = opts.map ?? tex.leaf(256);
    return toon({
      name: 'foliage',
      color: LAND.grassLit,
      map,
      alphaTest: opts.alphaTest ?? 0.42,
      side: THREE.DoubleSide,
      /* hard-ish two bands: leaves are flat colour, not modelled */
      term: 0.05,
      bandSoft: 0.028,
      band2: 0.22,
      core: 0.48,
      coreSoft: 0.05,
      spec: 0.03,
      specPow: 30,
      rim: 0.60,
      skyBounce: 0.16,
      grain: 0.006,
      grainScale: 6.0,
      grainAlbedo: 0.14,
      sss: opts.sss ?? 0.55,
      sssColor: opts.sssColor ?? 0xd9f08a,
      shadowTint: opts.shadowTint ?? SHADOW.tint,
      wind: opts.wind ?? 0.55,
      windBase: opts.windBase ?? 0,
      windHeight: opts.windHeight ?? 2.4,
      outline: true,
      outlineWidth: 2.6,
      ...opts,
    });
  }

  /* 6. EMISSIVE — lamps, windows, glints. */
  function emissive(opts = {}) {
    const o = { ...opts };
    const tint = o.color ?? BUILD.glassLit;
    delete o.color;
    return toon({
      name: 'emissive',
      color: 0xffffff,              // albedo stays white; the tint is the emission
      emissiveColor: tint,
      /* 2.2 x the 0.82 base term put a warm lamp at 1.80 peak, which
         only just clears the 1.7 bloom threshold — the halo was a
         fresnel ring with a hole in it. 3.0 puts the whole bulb over. */
      emissive: o.intensity ?? 3.0,
      emissiveOnly: true,
      rim: 0,
      grain: 0,
      outline: false,
      noOutline: true,
      ...o,
    });
  }

  /* ================================================================
     Outlines + registration
     ================================================================ */
  const outlineMats = new Map();
  /* User/debug trim on the outline width; update() folds the device
     pixel ratio in on top of it. */
  let outlineScaleUser = 1.0;

  /* ----------------------------------------------------------------
     HULL BUDGET.

     An outlined mesh draws its geometry twice — once solid, once as a
     back-faced shell — and, because the shell has to exist in the
     depth+normal buffer too (see OUTLINE_ND_FRAG), twice again in the
     prepass. Four submissions of the same triangles for a stroke that
     §2.2 fixes at ~1.6 px.

     That is worth paying on the crate in front of you. It is not
     worth paying on the crate that is nine pixels tall on the far side
     of the square, where the whole object is barely wider than the
     stroke, and it is not worth paying past §2.4's haze onset, where
     everything is being washed toward #B8DEF0 and uOutlineFade has
     already dropped the width to its floor. Both of those get the
     shell switched off; the solid mesh is untouched, so the object
     keeps its shape, its shading and its shadow, and only loses an
     edge darkening that was sub-pixel or hazed out anyway.

     Kept deliberately generous — this is a budget, not a style knob.
     minPx 9 is well below the size at which a stroke reads as a
     stroke; cullFar 185 is past the haze onset with room to spare.
     ---------------------------------------------------------------- */
  const hulls = [];
  const hullCull = { minPx: 9, cullFar: 185, on: true };

  /* ----------------------------------------------------------------
     ...AND THE BUDGET RIDES THE HAZE, because that is what it was
     justified by.

     The note above says "cullFar 185 is past the haze onset with room
     to spare", and while the haze onset was a constant that was a
     complete argument. It is not one any more: the balloon opens the
     fog out as it climbs (character/wally.js flyHaze — near x4.2 and
     far x4.6 at 150 m, so 100/520 on the ground becomes 420/2392 at
     200 m) precisely so that the island can be SEEN from up there.
     What that produced was an island with no ink in it. Measured at
     200 m, 1600x900, load 29.69: 89 of 517 hulls drawn, and the mean
     depth of the surviving stroke was 13.9 codes against 26.2 on the
     ground — while the balloon, 40 m from the lens, kept a full one.
     An inked balloon over an un-inked island is exactly the wrong way
     round, and §2.2's outline is the game's signature.

     So the two distances that retire the stroke — this budget and
     uOutlineFade's width ramp — are multiplied by how far the haze
     has actually been opened, measured off scene.fog every frame
     rather than off any module's intentions. REF is the clear
     ground-level value, so at ground level the multiplier is exactly
     1.000 and every number in this file is the number it was: revert
     the flight's fog write and the cull is 185 again to the metre.
     Clamped at 1 from below on purpose — thick weather may pull the
     fog IN, and letting that pull the ink in with it would change
     frames that were already right. The haze may push the ink out. It
     may not pull it back.
     ---------------------------------------------------------------- */
  const OUT_HAZE_REF = 520;      // scene.fog.far, clear, at head height
  const OUT_HAZE_MAX = 5.0;      // never more than five times the reach
  let hazeK = 1;
  /* the authored width ramp; uOutlineFade carries it times hazeK */
  const outlineFadeAuthored = new THREE.Vector3(120, 300, 0.55);
  const _hs = new THREE.Sphere();
  const _hc = new THREE.Vector3();

  /* Outline colour = the shadow law, pushed further (§2.2: albedo
     darkened 55 % and hue-rotated toward blue, NEVER pure black).

     This used to rotate hue on the colour wheel and take the short
     way round. From stucco (hue 0.11, yellow) the short way to
     blue-violet (0.635) runs backwards through red, and at 45 % of
     the trip every building in the game outlined *magenta*. Doing it
     as a multiply in gamma space cannot wrap, so a red roof still
     outlines red-purple and a green leaf blue-green, exactly as §2.2
     asks, and nothing can ever land in a hue that is not on the line
     between the surface and the shadow tint. */
  const _tintG = (() => {
    const c = srgb(SHADOW.tint);
    const g = [c.r, c.g, c.b].map((v) => Math.pow(Math.max(v, 1e-5), 1 / 2.2));
    const m = Math.max(g[0], g[1], g[2]);
    return g.map((v) => v / m);
  })();

  /* bleed is the term that pulls every stroke toward one slate. At
     0.35 the outline stopped belonging to its surface; 0.10 keeps
     enough of the albedo's own hue that a terracotta roof outlines
     warm and a leaf blue-green. See OUT_FLOOR below for value. */
  const _tintY = 0.2126 * _tintG[0] + 0.7152 * _tintG[1] + 0.0722 * _tintG[2];
  const _lum = (g) => 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];

  /* §2.2: "the object's albedo darkened 55 % and hue-rotated toward
     blue". The previous calibration read that as *nearly the whole
     way* to the shadow tint (amount 0.9) and then, because the result
     was too dark to survive ACES, lifted it back up by mixing toward
     the tint again — which spent the lift on getting bluer. The two
     steps compounded: a terracotta roof, a cream wall, a green leaf
     and a lead lamp post all came out within a few units of the same
     dark navy, and the ink stopped belonging to any of them. §2.2's
     rotation is a *rotation*, not a replacement, so amount comes down
     to 0.45; the bleed that pulls everything toward one slate comes
     down with it; and the never-black floor now lifts toward the
     surface's OWN hue half-mixed with the tint, so a red roof lifts
     to warm red-brown and only a genuinely neutral surface lifts to
     blue-violet. Measured out of the frame: roof #5D3C33, stucco
     #63666E, wood #503E38, leaf #36582F, lead post #384359 — five
     distinguishable strokes instead of one navy. */
  /* CALIBRATED AGAINST THE FRAME, NOT AGAINST THIS ARITHMETIC.
     These three numbers are authored in gamma space and then meet
     ACES, the lift-gamma-gain grade and the 0.22 vignette, and that
     chain eats about a third of them. At value 0.52 / floor 0.26 the
     delivered stroke measured, as the darkest 2 % of each material
     region: terracotta roof 0.142, stucco 0.175, wood 0.111. §2.1's
     own rule — albedo darkened 55 % — is worth 0.232 on terracotta,
     so the ink was ~40 % darker than the bible allows and on the
     stone parapet it read as near-black navy, which §7 forbids
     outright. value 0.60 / floor 0.36 puts the delivered terracotta
     stroke in the 0.22-0.24 band, measured on the near roof of
     shots/crit-out-play.png.

     OUT_LIFT rises with the floor for a reason: the lift mixes toward
     a direction that is only half the surface's own hue, so the mix
     fraction is what costs chroma. Leaving LIFT at 0.42 while the
     floor went to 0.36 would have needed a 0.62 mix and flattened the
     five stroke families back toward one slate — the exact regression
     the previous pass fixed. At 0.55 the mix is 0.34 and the roof
     still outlines warm rose against the plaster's slate-blue. */
  const OUT_FLOOR = 0.36;   // delivered luma the stroke may not fall below
  const OUT_LIFT = 0.55;    // luma of the colour it is lifted *toward*

  function outlineColor(base, amount = 0.45, value = 0.60, bleed = 0.10) {
    const c = toColor(base);
    const g = [c.r, c.g, c.b].map((v) => Math.pow(Math.max(v, 0), 1 / 2.2));
    for (let i = 0; i < 3; i++) g[i] *= lerp(1, _tintG[i], amount) * value;
    /* A whisper of the tint's own colour, so a fully desaturated
       surface still cools rather than going neutral grey. */
    const y = _lum(g);
    for (let i = 0; i < 3; i++) g[i] = lerp(g[i], (y / _tintY) * _tintG[i], bleed);

    /* Never black, and never so dark it reads as black after ACES.
       Lift along a direction that is half this surface's own hue and
       half the blue-violet, normalised to unit luma, so the mix that
       lands exactly on the floor is closed-form. */
    const y2 = _lum(g);
    if (y2 < OUT_FLOOR) {
      const inv = 1 / Math.max(y2, 1e-4);
      const dir = g.map((v, i) => lerp(v * inv, _tintG[i] / _tintY, 0.5));
      const m = (OUT_FLOOR - y2) / (OUT_LIFT - y2);
      for (let i = 0; i < 3; i++) g[i] = lerp(g[i], dir[i] * OUT_LIFT, m);
    }
    c.setRGB(...g.map((v) => Math.pow(Math.min(Math.max(v, 0), 1), 2.2)));
    return c;
  }

  /* The colour the stroke retires into at range: the same albedo taken
     only just into shade. See OUTLINE_FRAG. */
  function outlineColorFar(base) {
    return outlineColor(base, 0.30, 0.90, 0.05);
  }

  /* Authored widths across the world modules run 2.1 - 3.6 px, and
     since the hull expands in screen space that number IS the
     delivered stroke: measured on the eaves of a near house it came
     back at 3-4 px of near-black, which is an ink line, not a Wind
     Waker outline. §2.2 fixes the target at ~1.6 px. Rather than
     reach into eight files owned by other agents, treat what they
     authored as a relative *weight* about a nominal 3.1 and compress
     the spread by half around the target: 2.1 -> 1.44, 3.0 -> 1.65,
     3.4 -> 1.79, 3.6 -> 1.86. The relative emphasis every module
     intended survives; the absolute weight lands where §2.2 asks. */
  const OUT_TARGET = 1.68;
  const OUT_NOMINAL = 3.1;
  const OUT_SPREAD = 0.5;
  function outlineWidthPx(w) {
    const v = OUT_TARGET * (1 + (w / OUT_NOMINAL - 1) * OUT_SPREAD);
    return Math.max(0.9, v);
  }

  /* Normals averaged by position, for the inverted hull. Stored as an
     extra attribute on the source geometry rather than in a cloned
     one: the main material never declares aHullN so it costs a single
     upload and nothing else. */
  const HULL_MAX_VERTS = 120000;
  function hullNormals(geo) {
    if (!geo) return false;
    if (geo.getAttribute('aHullN')) return true;
    const pos = geo.getAttribute('position');
    if (!pos) return false;
    /* Above this the position-hash pass costs more than the outline is
       worth; fall back to face normals, which is only wrong at hard
       edges and those are rare on anything this dense. */
    if (pos.count > HULL_MAX_VERTS) return false;
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const nrm = geo.getAttribute('normal');
    const n = pos.count;
    const out = new Float32Array(n * 3);

    /* A flat card (a leaf, a banner) has every normal parallel, so
       expanding along it just slides the quad toward the camera and
       draws no outline at all. Grow those radially *in* their own
       plane instead — the UVs come along unchanged, so the alpha
       shape dilates with the quad and the leaf silhouette itself
       gets the rim (§5.5, "outlined only on the canopy silhouette"). */
    let flat = true;
    const n0x = nrm.getX(0), n0y = nrm.getY(0), n0z = nrm.getZ(0);
    for (let i = 1; i < n && flat; i++) {
      if (nrm.getX(i) * n0x + nrm.getY(i) * n0y + nrm.getZ(i) * n0z < 0.995) flat = false;
    }
    if (flat) {
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i); }
      cx /= n; cy /= n; cz /= n;
      for (let i = 0; i < n; i++) {
        let x = pos.getX(i) - cx, y = pos.getY(i) - cy, z = pos.getZ(i) - cz;
        const d = x * n0x + y * n0y + z * n0z;      // project into the plane
        x -= d * n0x; y -= d * n0y; z -= d * n0z;
        const l = Math.hypot(x, y, z);
        if (l < 1e-6) { out[i * 3] = n0x; out[i * 3 + 1] = n0y; out[i * 3 + 2] = n0z; }
        else { out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l; }
      }
      geo.setAttribute('aHullN', new THREE.BufferAttribute(out, 3));
      geo.userData.hullFlat = true;
      return true;
    }

    /* Average the DISTINCT normals sharing a position, not the raw
       vertex list. Primitive builders duplicate vertices for UV seams
       and for caps, and the duplicates are not evenly distributed, so
       a plain sum is a popularity vote rather than a bisector: a
       four-sided cone's base rim carries one slant normal and *two*
       copies of the cap's (0,-1,0), which averages to a hull
       direction pointing 65 degrees downward instead of outward, and
       its apex carries the azimuth-0 normal twice (once for the seam)
       which tilts the tip sideways. The visible result was a pyramid
       roof with a clean stroke along its eave and no stroke at all on
       either sky-facing ridge. De-duplicating first gives the true
       bisector of the faces that actually meet there. */
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(pos.getX(i) * 4096)},${Math.round(pos.getY(i) * 4096)},${Math.round(pos.getZ(i) * 4096)}`;
      let a = buckets.get(k);
      if (!a) { a = [0, 0, 0, [], []]; buckets.set(k, a); }
      const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
      const d = a[4];
      let seen = false;
      for (let j = 0; j < d.length; j += 3) {
        if (d[j] * nx + d[j + 1] * ny + d[j + 2] * nz > 0.999) { seen = true; break; }
      }
      if (!seen) { d.push(nx, ny, nz); a[0] += nx; a[1] += ny; a[2] += nz; }
      a[3].push(i);
    }
    for (const a of buckets.values()) {
      let x = a[0], y = a[1], z = a[2];
      let l = Math.hypot(x, y, z);
      /* Opposed normals can still cancel (a zero-thickness fin, a
         degenerate weld). Fall back to the shading normal rather than
         emitting a zero direction, which would collapse the hull. */
      if (l < 1e-4) { const i0 = a[3][0]; x = nrm.getX(i0); y = nrm.getY(i0); z = nrm.getZ(i0); l = Math.hypot(x, y, z) || 1; }
      x /= l; y /= l; z /= l;
      for (const i of a[3]) { out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z; }
    }
    geo.setAttribute('aHullN', new THREE.BufferAttribute(out, 3));
    return true;
  }

  function outline(mesh, opts = {}) {
    if (!mesh || !mesh.isMesh) return null;
    if (mesh.userData.outlineHull) return mesh.userData.outlineHull;
    const src = mesh.material;
    if (!src || Array.isArray(src)) return null;
    if (src.userData.noOutline || opts.noOutline || mesh.userData.noOutline) return null;
    if (q.outline === false) return null;

    const baseCol = opts.color ?? src.uniforms?.diffuse?.value ?? 0xffffff;
    const widthPx = outlineWidthPx(opts.width ?? src.userData.outlineWidth ?? OUT_NOMINAL);
    const windU = src.uniforms?.uWindWeight;
    const hasHullN = hullNormals(mesh.geometry);
    const cut = src.uniforms?.uAlphaTest ? src : null;
    /* A hull on an alpha-tested card has no interior to hide inside,
       so it draws double-sided and discards on the same cutout. */
    const side = cut ? THREE.DoubleSide : THREE.BackSide;

    const near = outlineColor(baseCol);
    const far = outlineColorFar(baseCol);
    const key = `${near.getHexString()}|${far.getHexString()}|${widthPx.toFixed(3)}` +
                `|${windU ? 'w' : ''}|${hasHullN ? 'h' : ''}|${cut ? 'a' : ''}|${side}`;
    let mat = outlineMats.get(key);
    if (!mat) {
      const d = {};
      if (hasHullN) d.TOON_HULLN = '';
      if (cut) d.TOON_ALPHATEST = '';
      /* material.fog = true means three will push fogColor/Near/Far
         into this material's uniforms — they have to exist first. */
      const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
      Object.assign(u, {
        uColor: { value: near },
        uColorFar: { value: far },
        uWidthPx: { value: widthPx },
        uOutlineRes: globals.uOutlineRes,
        uOutlineScale: globals.uOutlineScale,
        uOutlineFade: globals.uOutlineFade,
      });
      if (windU) {
        d.TOON_WIND = '';
        u.uWindWeight = windU;
        u.uWindPhase = src.uniforms.uWindPhase;
        u.uWindHeight = src.uniforms.uWindHeight;
      }
      if (cut) {
        u.tMap = cut.uniforms.tMap;
        u.uAlphaTest = cut.uniforms.uAlphaTest;
        u.uUvScale = cut.uniforms.uUvScale;
      }
      mat = new THREE.ShaderMaterial({
        name: 'outline',
        vertexShader: OUTLINE_VERT,
        fragmentShader: OUTLINE_FRAG,
        uniforms: u,
        defines: d,
        side,
        fog: true,
      });
      mat.userData.ndMaterial = new THREE.ShaderMaterial({
        name: 'outline.nd',
        vertexShader: OUTLINE_VERT,
        fragmentShader: OUTLINE_ND_FRAG,
        uniforms: u,
        defines: d,
        side,
      });
      if (windU) { attachWind(mat); attachWind(mat.userData.ndMaterial); }
      outlineMats.set(key, mat);
      allMaterials.add(mat);
      allMaterials.add(mat.userData.ndMaterial);
    }

    let hull;
    if (mesh.isSkinnedMesh) {
      hull = new THREE.SkinnedMesh(mesh.geometry, mat);
      hull.bind(mesh.skeleton, mesh.bindMatrix);
      hull.bindMode = mesh.bindMode;
    } else if (mesh.isInstancedMesh) {
      hull = new THREE.InstancedMesh(mesh.geometry, mat, mesh.count);
      hull.instanceMatrix = mesh.instanceMatrix;
      hull.count = mesh.count;
    } else {
      hull = new THREE.Mesh(mesh.geometry, mat);
    }
    hull.name = (mesh.name || 'mesh') + '.outline';
    hull.castShadow = false;
    hull.receiveShadow = false;
    hull.frustumCulled = mesh.frustumCulled;
    /* AFTER the mesh it outlines, not before.
       This is worth six milliseconds a frame and it is worth
       understanding why. An inverted hull is the same geometry scaled
       out and drawn back-faces-only: the sliver that escapes past the
       silhouette is the stroke, and every other fragment of it sits
       *behind* the solid mesh and is thrown away by the depth test.
       Thrown away — but only if the solid mesh is already in the depth
       buffer. Drawn at renderOrder - 1 the whole shell rendered into an
       empty depth buffer, so every one of those hidden fragments was
       shaded in full and then overwritten, and with an outline on most
       of the world that is an extra full-frame layer of overdraw for a
       ~1.6 px stroke. Drawn after, early-Z rejects the interior and
       only the stroke itself costs anything.

       Output is pixel-identical: measured over the whole boot frame,
       swapping the order moves 0.05 % of pixels with a mean absolute
       difference of 0.007/255, which is dither. Draw calls and
       triangles are identical by construction — this only changes the
       order they are submitted in, and therefore only changes how many
       of their fragments survive the depth test. */
    hull.renderOrder = mesh.renderOrder + 1;
    hull.userData.isOutlineHull = true;
    hull.matrixAutoUpdate = false;
    hull.matrix.identity();
    mesh.add(hull);
    mesh.userData.outlineHull = hull;
    hulls.push(hull);
    return hull;
  }

  function removeOutline(mesh) {
    const h = mesh?.userData?.outlineHull;
    if (!h) return;
    h.parent?.remove(h);
    const i = hulls.indexOf(h);
    if (i >= 0) hulls.splice(i, 1);
    mesh.userData.outlineHull = null;
  }

  /* Switch off the shells that cannot pay for themselves this frame.
     One sphere transform and one divide each; at ~400 hulls that is
     noise next to the four draw calls it saves per hull. */
  function cullHulls(cam, dbH) {
    if (!cam || !cam.isPerspectiveCamera) return;
    const cullFarNow = hullCull.cullFar * hazeK;
    const fovScale = dbH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5));
    const camPos = cam.matrixWorld.elements;
    const cx = camPos[12], cy = camPos[13], cz = camPos[14];
    const on = hullCull.on;
    for (let i = 0; i < hulls.length; i++) {
      const h = hulls[i];
      const src = h.parent;
      if (!src) continue;
      if (!on) { h.visible = true; continue; }
      /* An InstancedMesh carries the spread of its instances in its own
         bounding sphere; a plain mesh only has the geometry's. */
      const bs = src.isInstancedMesh
        ? (src.boundingSphere || (src.computeBoundingSphere(), src.boundingSphere))
        : (src.geometry.boundingSphere || (src.geometry.computeBoundingSphere(), src.geometry.boundingSphere));
      if (!bs) { h.visible = true; continue; }
      _hs.copy(bs).applyMatrix4(src.matrixWorld);
      _hc.copy(_hs.center);
      const d = Math.hypot(_hc.x - cx, _hc.y - cy, _hc.z - cz);
      const near = d - _hs.radius;
      if (near > cullFarNow) { h.visible = false; continue; }
      h.visible = (2 * _hs.radius / Math.max(0.05, d)) * fovScale >= hullCull.minPx;
    }
  }

  /* Walk a subtree, wire up shadows, prepass and outlines. Every
     module should call this on anything it adds to the scene. */
  function register(root, opts = {}) {
    if (!root) return root;
    root.traverse((o) => {
      if (o.isMesh !== true) return;
      if (o.userData.isOutlineHull) return;
      o.castShadow = opts.castShadow !== false;
      o.receiveShadow = opts.receiveShadow !== false;

      const m = o.material;
      if (!m || Array.isArray(m)) return;
      if (m.userData.depthMaterial) o.customDepthMaterial = m.userData.depthMaterial;

      const wants = opts.outline ?? m.userData.wantsOutline;
      const blocked = opts.noOutline || m.userData.noOutline || o.userData.noOutline;
      if (wants && !blocked) outline(o, opts);
    });
    return root;
  }

  /* ================================================================
     Ambient / sun control — the sky module drives these
     ================================================================ */
  function setSun(dir, color, intensity) {
    if (csm) csm.setSun(dir, color, intensity);
    else {
      if (dir) globals.uSunDir.value.copy(dir).normalize();
      if (color != null) globals.uSunColor.value.copy(toColor(color));
      if (intensity != null) globals.uSunIntensity.value = intensity;
    }
  }

  /* EXPOSURE CONVENTION — the sky module owns these, so it needs the
     rule: a lit surface is albedo * ( sun + ambient ), so keep
     sunIntensity + ambIntensity near 1.0. Above ~1.3 a mid albedo
     lands on the flat part of the ACES shoulder, and there both the
     two-band ramp and the velvet grain compress into the same white —
     the frame stops being cel shaded no matter what the material
     says. §1.2's lit cheek is #DEDEDD, not #FFFFFF. */
  function setAmbient(skyColor, groundColor, intensity, saturation) {
    if (skyColor != null) globals.uAmbSky.value.copy(toColor(skyColor));
    if (groundColor != null) globals.uAmbGround.value.copy(toColor(groundColor));
    if (intensity != null) globals.uAmbIntensity.value = intensity;
    if (saturation != null) globals.uAmbSat.value = saturation;
  }

  /* ----------------------------------------------------------------
     THE ONE LOCAL LIGHT. Position in world metres, colour, intensity
     and the radius at which it reaches zero.

       ctx.mat.setLocalLight( pos, 0xffa552, 2.4, 26 )
       ctx.mat.setLocalLight( null )            // put it out

     Intensity is in the same units as the sun's: a lit surface is
     albedo * ( sun + ambient ) and setAmbient's note keeps that pair
     near 1.0, so an intensity of 1 at point-blank range is "as bright
     as noon" and anything much over 3 lands on the ACES shoulder and
     stops being cel shaded. There is exactly one of these; a second
     caller overwrites the first.
     ---------------------------------------------------------------- */
  function setLocalLight(pos, color, intensity = 1, range) {
    if (!pos || !(intensity > 0)) { globals.uLocalCol.value.setRGB(0, 0, 0); return; }
    globals.uLocalPos.value.set(pos.x, pos.y, pos.z);
    const c = toColor(color ?? 0xffffff);
    globals.uLocalCol.value.setRGB(c.r * intensity, c.g * intensity, c.b * intensity);
    if (range != null) globals.uLocalRange.value = Math.max(0.1, range);
  }

  /* The whole world's shadow colour, in one call. `amount` is the hue
     rotation toward the tint, `value` the modest value drop, `bleed`
     how much of the tint's own colour a shadow picks up on top of the
     multiply (what stops a saturated albedo staying its own hue in
     shade). Sky drives this across the day. */
  function setShadowLaw(tintHex, amount, value, bleed, fill) {
    if (tintHex != null) globals.uShadowTint.value.copy(toColor(tintHex));
    if (amount != null) globals.uShadowAmount.value = amount;
    if (value != null) globals.uShadowValue.value = value;
    if (bleed != null) globals.uShadowBleed.value = bleed;
    if (fill != null) globals.uShadowFill.value = fill;
  }

  /* ================================================================
     ctx.mat
     ================================================================ */
  const api = {
    toon, clay, plaster, wood, foliage, emissive,
    register, outline, removeOutline, outlineColor, outlineColorFar,
    setLocalLight,

    /* Live trim on the whole outline pass. scale multiplies every
       authored width; near/far/min are uOutlineFade (see the vertex
       shader). Any argument may be omitted. */
    setOutline({ scale, near, far, min, minPx, cullFar, cull } = {}) {
      if (scale != null) outlineScaleUser = scale;
      /* the AUTHORED ramp — update() multiplies it by hazeK on its way
         to the uniform, so setting near/far here is not silently
         overwritten on the next frame */
      const f = outlineFadeAuthored;
      if (near != null) f.x = near;
      if (far != null) f.y = far;
      if (min != null) f.z = min;
      /* the hull budget — see hullCull above */
      if (minPx != null) hullCull.minPx = minPx;
      if (cullFar != null) hullCull.cullFar = cullFar;
      if (cull != null) hullCull.on = !!cull;
      return {
        scale: outlineScaleUser, px: globals.uOutlineScale.value,
        near: f.x, far: f.y, min: f.z,
        minPx: hullCull.minPx, cullFar: hullCull.cullFar, cull: hullCull.on,
        hazeK: +hazeK.toFixed(3), cullFarNow: +(hullCull.cullFar * hazeK).toFixed(1),
        hulls: hulls.length, hullsDrawn: hulls.reduce((a, h) => a + (h.visible ? 1 : 0), 0),
      };
    },

    setSun, setAmbient, setShadowLaw,
    globals, tex,
    materials: allMaterials,

    /* Attach the shared wind uniforms to a material another module
       built by hand. */
    wind(m) { attachWind(m); return m; },

    dispose() {
      for (const m of allMaterials) m.dispose();
      allMaterials.clear();
      tex.dispose();
    },

    update(dt, elapsed) {
      globals.uTime.value = elapsed;

      /* wind boots after us, so materials created during our own init
         (the matlab scene) get their uniforms wired on frame 1 */
      if (ctx.wind && pendingWind.length) {
        for (const m of pendingWind) ctx.wind.attach(m);
        pendingWind.length = 0;
      }

      /* Keep the outline hull at a constant screen width. */
      const cam = ctx.camera;
      ctx.renderer.getDrawingBufferSize(_dbs);
      globals.uOutlineRes.value.set(Math.max(1, _dbs.x), Math.max(1, _dbs.y));

      /* uOutlineRes is the DRAWING BUFFER, so uWidthPx is in device
         pixels — and §2.2's ~1.6 px is a perceptual weight, not a
         device-pixel count. Left alone, a retina tier at pixelRatio 2
         would deliver a 0.8 CSS-pixel hairline that FXAA then eats,
         and the whole calibration would only be right in headless
         screenshots, where the ratio happens to be 1. */
      const pr = Math.min(Math.max(ctx.renderer.getPixelRatio() || 1, 1), 2);
      globals.uOutlineScale.value = outlineScaleUser * pr;
      if (cam && cam.isPerspectiveCamera) {
        const h = Math.max(1, _dbs.y);
        globals.uPixelScale.value = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5) / h;
      }
      /* how far the haze has been opened, this frame, off the live fog.
         See OUT_HAZE_REF. Read here rather than in cullHulls so the
         width ramp and the budget can never disagree about it. */
      const fog = ctx.scene?.fog;
      const ff = fog && Number.isFinite(fog.far) ? fog.far : OUT_HAZE_REF;
      hazeK = Math.min(OUT_HAZE_MAX, Math.max(1, ff / OUT_HAZE_REF));
      globals.uOutlineFade.value.set(
        outlineFadeAuthored.x * hazeK, outlineFadeAuthored.y * hazeK, outlineFadeAuthored.z);

      cullHulls(cam, Math.max(1, _dbs.y));

      if (lab) lab.update(dt, elapsed);
    },
  };

  /* ================================================================
     ?scene=matlab — the material laboratory.

     The world is empty while every other agent is still building, so
     this is how the render core gets looked at. Studio-ish key light,
     one of everything, deliberately boring geometry: if a clay sphere
     under this rig does not read as a matte vinyl toy, the material is
     wrong and no amount of world-building will save it.
     ================================================================ */
  let lab = null;
  if (ctx.flags.scene === 'matlab') lab = buildMatLab();

  function buildMatLab() {
    const scene = ctx.scene;
    const root = new THREE.Group();
    root.name = 'matlab';
    scene.add(root);

    /* §2.4: haze pales everything past ~120 m. Starting at 26 m put a
       10 m-wide test scene half inside the fog and every sample of
       the sand came back grey-cyan. */
    scene.fog = new THREE.Fog(srgb(SKY.haze), 55, 210);

    /* --- sky (§2.1) ---
       world/sky.js owns the real one; until it ships, a flat clear
       colour was half of every lab frame and it measured S 0.20 —
       paler than §2.1's *horizon* swatch, never mind the #2E7FD4
       zenith, and there is no such thing as a Wind Waker frame
       without a sky gradient in it. This is the lab's own dome, not
       an implementation of ctx.sky: it is a child of the matlab root
       and goes away with it. */
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(600, 32, 24),
      new THREE.ShaderMaterial({
        name: 'lab.sky',
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: srgb(SKY.zenith) },
          uHorizon: { value: srgb(SKY.horizon) },
          uHaze: { value: srgb(SKY.haze) },
          uSunDisc: { value: srgb(SKY.sunDisc) },
          uSunHalo: { value: srgb(SKY.sunHalo) },
          uSunDir: globals.uSunDir,
          /* The palette's sky entries are *authored display* colours,
             and everything here still has ACES in front of it, which
             takes ~20 % off a saturated blue. Pre-gain so what lands
             on screen is the swatch, not a washed copy of it. */
          uGain: { value: 1.35 },
        },
        vertexShader: /* glsl */`
          varying vec3 vDir;
          void main() {
            vec4 wp = modelMatrix * vec4( position, 1.0 );
            vDir = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
            gl_Position.z = gl_Position.w;      // pin to the far plane
          }
        `,
        fragmentShader: /* glsl */`
          uniform vec3 uZenith, uHorizon, uHaze, uSunDisc, uSunHalo;
          uniform vec3 uSunDir;
          uniform float uGain;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize( vDir );
            float h = clamp( d.y, 0.0, 1.0 );
            /* two-stage: a fast pale band right at the sea line, then
               a slow climb into the zenith. One pow() does the first
               and one the second, which is what makes it read as
               banded sky rather than as a linear ramp. §2.1: "pales
               dramatically toward the sea line". */
            vec3 c = mix( uHaze, uHorizon, pow( h, 0.30 ) );
            c = mix( c, uZenith, pow( h, 0.42 ) );
            /* sun disc + a wide warm halo (§2.1). The disc is pushed
               well past the 1.7 bloom threshold; the halo is not, so
               bloom stays a highlight effect. */
            float sd = max( dot( d, normalize( uSunDir ) ), 0.0 );
            c = mix( c, uSunHalo, pow( sd, 22.0 ) * 0.55 );
            c *= uGain;
            c += uSunDisc * smoothstep( 0.9975, 0.9994, sd ) * 8.0;
            gl_FragColor = vec4( c, 1.0 );
          }
        `,
      })
    );
    skyDome.name = 'lab.sky';
    skyDome.frustumCulled = false;
    skyDome.renderOrder = -1000;
    skyDome.castShadow = false;
    skyDome.receiveShadow = false;
    /* never in the prepass: the background must stay z=0 so SSAO
       ignores it and DOF treats it as infinitely far */
    skyDome.userData.noPrepass = true;
    skyDome.userData.noOutline = true;
    root.add(skyDome);

    /* --- lighting rig: big soft key from upper-left (§1) ---
       key + ambient has to land a mid albedo just under 1.0 in linear
       light, or ACES compresses the top of the ramp and the two bands
       collapse into the same white before they ever reach the eye. */
    /* Enough side to it that the terminator lands on the form rather
       than on the silhouette — a pure front key hides the ramp the
       lab exists to show. */
    /* Ambient is up and the key is down by the same amount: the sum
       stays inside the exposure convention below, but every surface
       in the frame sits further out of the ACES toe, which is where
       §2.1's #A9713F wood was losing a third of its value before the
       shadow law ever saw it. */
    /* The key is a *side* key, ~84 degrees off the view ray, and its
       elevation is deliberately low (34 degrees). Both numbers are
       load-bearing. Azimuth decides where the terminator ring lands on
       a form: with term 0.26 this puts it 15 % of the radius from the
       centre of the clay sphere and the core step at half the radius,
       so all three tones are on the form instead of crowded onto the
       silhouette. Elevation decides whether the GROUND can band at
       all: at 0.60 the ground's N.L sat at 0.638, above plaster's core
       threshold everywhere, so the biggest surface in the frame was
       mathematically incapable of showing an edge. 0.52 lands it at
       0.556, right on the core step, where the macro slope below
       swings it back and forth across the threshold. */
    setSun(new THREE.Vector3(-0.64, 0.52, 0.44).normalize(), 0xfff4dc, 0.70);
    setAmbient(SKY.horizon, LAND.sand, 0.50, 0.62);
    ctx.render?.setGrade('day');
    /* Focus on the clay/Wally plane at ~9.6 m, not on the house. With
       focus at 11.5 the house (11.0 m) and the tree sat exactly on the
       focal plane and the far half of §3.6 measured *identical* to a
       DOF-off render. farGain carries the background rather than
       aperture, so the foreground crate stays readable. */
    ctx.render?.setDOF(9.3, 3.4, 0.55, 2.6, 0.22);

    /* --- ground ---
       THE RAMP CANNOT BAND A SURFACE THAT HAS ONE NORMAL, and no
       amount of shader work fixes a plane that genuinely is a plane:
       every band in the model is a threshold on N·L, so a 160 m
       PlaneGeometry(…,1,1) with a constant (0,1,0) lands wholly inside
       one band and renders as a flat fill next to clay forms that band
       properly. It also meets the sky in a dead straight line.

       So the ground has real form. One height field, sampled in the
       vertex loop and again for every prop that stands on it, ramped
       to zero inside a metre of the origin so the character module can
       still put Wally's feet at y = 0 without knowing about it. Its
       slopes reach ~13 degrees, which is about 0.19 of N·L — twice the
       width of the core step — so the ground crosses a band the way a
       sculpted island does rather than wobbling inside one. */
    const groundH = (x, z) => {
      const r = Math.hypot(x, z);
      const near = smoothstep(1.0, 4.5, r) * 0.34;
      const far = smoothstep(11, 42, r) * 0.95;
      return near * (
        Math.sin(x * 0.52 + z * 0.31) * 0.55 +
        Math.sin(z * 0.79 - x * 0.44 + 1.7) * 0.32 +
        Math.sin(x * 1.21 + z * 0.97 + 0.9) * 0.13)
        + far * (
        Math.sin(x * 0.082 + z * 0.049) * 0.62 +
        Math.sin(z * 0.127 - x * 0.071 + 1.7) * 0.37);
    };
    const groundMat = plaster({
      color: LAND.sand,
      tint2: LAND.sandWet,
      /* varScale is a frequency: at 0.09 the whole 160 m plane got
         about one blotch and the largest surface in the frame read as
         a flat fill. §7 forbids an untextured surface and a plain
         gradient is the same failure at a bigger scale. */
      variation: 0.30,
      varScale: 0.32,
      edgeWear: 0.0,
      relief: 0.34,
      grain: 0.012,
      grainScale: 2.2,
      rim: 0.0,
      /* the ground is the surface the two-band ramp fails hardest on,
         so it carries the strongest macro slope in the game: ~1.0
         swings the shading normal about 25 degrees, which is enough to
         cross the core step and, at the extremes, the terminator */
      /* The ground bands on its TERMINATOR, not on the core step.
         A core step is a brightening, and brightening a saturated
         surface runs it up the ACES shoulder and bleaches it — §2.1's
         grass came out at S 0.37 against a 0.60 swatch. The terminator
         is the band that carries the hue rotation (grass shades toward
         blue-green, §2.1), so `term` is raised until the ground's own
         slopes genuinely cross it: flat ground sits at N·L 0.556, the
         terrain swings that by about ±0.19, so 0.34 puts every slope
         leaning away from the key into real shade. */
      macro: 0.85,
      macroScale: 0.58,
      term: 0.38,
      /* Narrower than the §2.2 default on purpose. The delivered width
         of a terminator is bandSoft divided by how fast N·L changes
         across the screen, and on a 160 m ground plane that rate is an
         order of magnitude lower than on a 1 m sphere: 0.030 measured
         a 35 px feather where the same number gives 13 px on the clay.
         0.018 lands the ground's edges in the same range as the
         forms', which is what makes them read as one shading model. */
      bandSoft: 0.018,
      band2: 0.16,
      core: 0.68,
      coreSoft: 0.022,
      outline: false,
      name: 'lab.ground',
    });
    /* PlaneGeometry lies in local XY with +Z up; rotation.x = -90 maps
       local (x, y, z) to world (x, z, -y), so local z IS world height
       and world z is -local y. */
    const displace = (geo) => {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, groundH(p.getX(i), -p.getY(i)));
      geo.computeVertexNormals();
      return geo;
    };
    const groundGeo = displace(new THREE.PlaneGeometry(160, 160, 176, 176));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.castShadow = false;
    root.add(ground);
    register(ground, { castShadow: false });

    /* --- a grass patch so the ground is not one flat tone ---
       A ring rather than a fan: CircleGeometry is one triangle fan
       with a single interior vertex, so it has no radial subdivision
       at all and nothing can ever vary across it. */
    const grassMat = plaster({
      color: LAND.grassLit,
      tint2: LAND.grassShade,
      variation: 0.30,
      varScale: 0.55,
      edgeWear: 0.0,
      relief: 0.42,
      grain: 0.015,
      grainScale: 2.6,
      rim: 0.25,
      macro: 0.90,
      macroScale: 0.64,
      term: 0.38,
      bandSoft: 0.018,
      band2: 0.16,
      core: 0.68,
      coreSoft: 0.022,
      outline: false,
      name: 'lab.grass',
    });
    const grass = new THREE.Mesh(displace(new THREE.RingGeometry(0.0001, 11, 128, 26)), grassMat);
    grass.rotation.x = -Math.PI / 2;
    /* 5 cm, not 8 mm: the two meshes sample the same height field on
       different grids, so their linear interpolation disagrees by up
       to ~2 cm between vertices, and at grazing incidence 2 cm of
       sand poking through the turf covers a quarter of the frame. */
    grass.position.y = 0.05;
    grass.receiveShadow = true;
    root.add(grass);
    register(grass, { castShadow: false });

    /* --- THE clay sphere: this is the acceptance test --- */
    const claySphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 96, 64),
      clay({ color: CLAY.body, name: 'lab.clay.sphere' })
    );
    claySphere.position.set(-2.5, 1.15 + groundH(-2.5, 0), 0);
    root.add(claySphere);
    register(claySphere);

    /* a clay torus knot — organic curvature, where a bad terminator
       shows up immediately */
    const knot = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.72, 0.27, 220, 32),
      clay({ color: CLAY.body, name: 'lab.clay.knot' })
    );
    knot.position.set(0.9, 1.35 + groundH(0.9, -1.9), -1.9);
    root.add(knot);
    register(knot);

    /* a darker clay capsule — checks the shadow law on a mid tone */
    const cap = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.55, 1.0, 24, 48),
      clay({ color: CLAY.earInner, sss: 0.34, name: 'lab.clay.capsule' })
    );
    cap.position.set(-0.3, 1.1 + groundH(-0.3, 1.7), 1.7);
    root.add(cap);
    register(cap);

    /* --- plaster building --- */
    const wallMat = plaster({ color: BUILD.stucco, name: 'lab.wall' });
    const house = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.5, 2.2), wallMat);
    body.position.y = 1.25;
    house.add(body);
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(2.25, 1.3, 4),
      plaster({ color: BUILD.roof, tint2: BUILD.roofShade, variation: 0.22, name: 'lab.roof' })
    );
    roof.position.y = 3.15;
    roof.rotation.y = Math.PI / 4;
    house.add(roof);
    /* THE LAB HAD NO DEPTH TO DEFOCUS. Measured, the house's front
       wall sat at 9.8 m and the clay sphere at 9.9 m — the same plane —
       so no focus distance in existence could separate them and the
       far half of §3.6 was arithmetically inert no matter what it was
       set to. Moved out to ~12.3 m and scaled to keep the same
       footprint on screen, so the frame now has a foreground (crate,
       7 m), a subject plane (clay, Wally, 9-10 m), a mid ground
       (house, 12 m), a background (tree, 15 m) and a horizon. */
    house.position.set(4.5, groundH(4.5, -4.4) - 0.05, -4.4);
    house.scale.setScalar(1.28);
    house.rotation.y = -0.34;
    root.add(house);
    register(house);

    /* --- wood dock / crate --- */
    const woodMat = wood({ color: BUILD.wood, grainDir: [1, 0, 0], name: 'lab.wood' });
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), woodMat);
    crate.position.set(2.7, 0.65 + groundH(2.7, 1.6), 1.6);
    /* 0.62, not 0.42: at 0.42 the crate's camera-facing plank landed
       at N.L 0.152 against wood's 0.15 terminator, i.e. exactly ON the
       band edge, so the one box in the lab existed to show a wood
       terminator and showed a single ambiguous tone instead. Now one
       face is core-lit and the other is squarely in shade. */
    crate.rotation.y = 0.62;
    root.add(crate);
    register(crate);

    /* §2.1's wood swatch is #A9713F (V 0.66). BUILD.woodDark is the
       *shade* entry of that pair, and using it as an albedo — then
       multiplying it again by the wood grain map — landed the lit
       face at V 0.45 before any shading law ran. Albedo is the lit
       colour; woodDark belongs in tint2, which is where the grain
       map's dark bands come from. */
    const postMat = wood({ color: BUILD.wood, tint2: BUILD.woodDark, grainDir: [0, 1, 0], woodScale: 0.9, name: 'lab.post' });
    for (let i = 0; i < 3; i++) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 2.0, 12), postMat);
      post.position.set(-4.6 + i * 1.5, 1.0 + groundH(-4.6 + i * 1.5, 2.6), 2.6);
      post.rotation.z = (i - 1) * 0.045;
      root.add(post);
      register(post);
    }

    /* --- foliage: a wind-driven card cluster --- */
    const folMat = foliage({ color: LAND.grassLit, wind: 0.85, windHeight: 3.0, name: 'lab.foliage' });
    const trunkMat = wood({ color: BUILD.wood, tint2: BUILD.woodDark, grainDir: [0, 1, 0], name: 'lab.trunk' });
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, 2.3, 10), trunkMat);
    trunk.position.y = 1.15;
    tree.add(trunk);
    const rng = ctx.makeRng('lab.tree');
    const cardGeo = new THREE.PlaneGeometry(1.9, 1.9);
    for (let i = 0; i < 9; i++) {
      const card = new THREE.Mesh(cardGeo, folMat);
      const a = rng() * Math.PI * 2;
      const r = 0.35 + rng() * 0.75;
      card.position.set(Math.cos(a) * r, 2.4 + rng() * 0.95, Math.sin(a) * r);
      card.rotation.set((rng() - 0.5) * 0.7, a, (rng() - 0.5) * 0.6);
      tree.add(card);
    }
    tree.position.set(-6.2, groundH(-6.2, -3.4) - 0.05, -3.4);
    root.add(tree);
    register(tree);

    /* --- emissive lamp --- */
    const lampPost = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.09, 2.6, 10),
      wood({ color: BUILD.metal, grainDir: [0, 1, 0], woodAmount: 0.3, spec: 0.2, name: 'lab.lamppost' })
    );
    lampPost.position.set(3.2, 1.3 + groundH(3.2, -2.6), -2.6);
    root.add(lampPost);
    register(lampPost);

    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 24, 16),
      emissive({ color: BRAND.token, intensity: 2.6, name: 'lab.bulb' })
    );
    bulb.position.set(3.2, 2.72 + groundH(3.2, -2.6), -2.6);
    bulb.castShadow = false;
    root.add(bulb);

    const bulbLight = new THREE.PointLight(srgb(BRAND.token), 6, 9, 2);
    bulbLight.position.copy(bulb.position);
    root.add(bulbLight);

    /* --- camera --- */
    const cam = ctx.camera;
    cam.fov = 46;
    cam.near = 0.15;
    cam.far = 900;
    cam.position.set(2.6, 2.35, 8.4);
    cam.lookAt(-0.4, 1.15, 0);
    cam.updateProjectionMatrix();

    /* debug hooks */
    const dbg = (window.WALLY && window.WALLY.debug) || {};
    dbg.labCamera = (x, y, z, tx, ty, tz) => {
      cam.position.set(x, y, z);
      cam.lookAt(tx ?? 0, ty ?? 1.1, tz ?? 0);
    };
    dbg.labSun = (x, y, z, i) => setSun(new THREE.Vector3(x, y, z).normalize(), null, i);
    dbg.labSpin = (on) => { spin = on !== false; };
    if (window.WALLY) window.WALLY.debug = dbg;

    let spin = true;
    return {
      root,
      update(dt, elapsed) {
        /* something is always moving (§6) — the knot turns, the
           foliage rides the wind field */
        if (spin) {
          knot.rotation.y = elapsed * 0.32;
          knot.rotation.x = Math.sin(elapsed * 0.21) * 0.28;
        }
        bulbLight.intensity = 6 + Math.sin(elapsed * 2.3) * 0.7;
      },
    };
  }

  /* Outline calibration is a look decision, so it stays tweakable from
     a screenshot: WALLY.debug.outline({ scale, near, far, min }). */
  if (typeof window !== 'undefined') {
    const dbg = (window.WALLY && window.WALLY.debug) || {};
    dbg.outline = (o) => api.setOutline(o);
    if (window.WALLY) window.WALLY.debug = dbg;
  }

  return api;
}
