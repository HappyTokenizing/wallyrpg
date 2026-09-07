/* ============================================================
   postfx.js — the post chain, in the order ART_DIRECTION §3 demands.

     prepass (renderer.js) -> main forward (renderer.js)
     -> SSAO (0.9 m radius, soft, warm, 0.55)
     -> bloom (threshold 0.85, soft knee, N mips, warm)
     -> DOF (bokeh, near + far)
     -> ACES -> lift/gamma/gain -> grain 0.018 -> vignette 0.22 warm
     -> FXAA

   Everything upstream of the composite lives in HalfFloat linear
   light. The composite is the only place a value is tone-mapped, and
   the only place sRGB encoding happens; FXAA then runs on the encoded
   image, which is where it belongs (luma edges in perceptual space).
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import {
  GLSL_NOISE, GLSL_COLOR, GLSL_POISSON, GLSL_VIEWPOS, GLSL_DEPTH, GLSL_FINITE,
  spiralTaps,
} from './shaders.js';
import { damp } from '../core/contracts.js';

/* ------------------------------------------------------------------
   Grade presets. Lift pushes the toe blue-violet, gain pulls the
   shoulder to warm cream — the Wind Waker signature (§2.1, §3.7).
   ------------------------------------------------------------------ */
/* §3.7: shadows blue-violet, highlights warm cream.

   LIFT IS NOT ALLOWED TO DO THE SHADER'S JOB. It adds a *constant* in
   display-linear space, so it cannot rotate a hue — it can only paint
   one on. At lift.b 0.042 (where this shipped) a weathered wood post
   whose own blue is 0.004 came out 90 % grade, and the frame's dark
   props read as navy plastic rather than as wood in blue shade. The
   blue-violet in a shadow is produced by wShadeLaw() in toon.js, where
   it is relative to the albedo and the material keeps its identity;
   lift is only here to keep the very bottom of the toe off neutral.
   b is therefore a third of what it was across every preset.

   `bloom` is a *highlight* strength, not a veil: since the bloom
   prefilter threshold moved to 1.7 (see bloomPreMat) only genuinely
   emissive pixels reach the bloom buffer, so these numbers scale a
   halo around a lamp, not a wash over the whole frame. They came down
   accordingly. */
export const GRADES = {
  neutral: {
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], warm: [1, 1, 1],
    sat: 1.0, contrast: 1.0, exposure: 1.0, vignette: 0.16, bloom: 0.40,
  },
  day: {
    lift: [-0.010, -0.003, 0.014], gamma: [1.00, 1.005, 0.985], gain: [1.020, 1.008, 0.985],
    warm: [1.070, 1.008, 0.900],
    /* sat 1.10, not 1.18: with the bloom veil gone the frame arrives
       at the grade already carrying its own chroma, and the old value
       was pushing §2.1's wood past S 0.82 against a 0.63 swatch.
       exposure 1.05 puts §1.2's clay back at its #D3D3D2 value, which
       ACES had been landing 10 % under. */
    sat: 1.10, contrast: 1.08, exposure: 1.05, vignette: 0.26, bloom: 0.45,
  },
  golden: {
    lift: [-0.010, 0.002, 0.016], gamma: [0.985, 1.000, 1.015], gain: [1.045, 1.010, 0.960],
    warm: [1.120, 1.015, 0.845],
    sat: 1.18, contrast: 1.09, exposure: 0.98, vignette: 0.28, bloom: 0.58,
  },
  dusk: {
    lift: [0.002, 0.003, 0.018], gamma: [1.00, 1.00, 1.02], gain: [1.035, 0.995, 0.975],
    warm: [1.105, 0.985, 0.880],
    sat: 1.12, contrast: 1.10, exposure: 0.94, vignette: 0.30, bloom: 0.62,
  },
  night: {
    lift: [-0.008, 0.002, 0.020], gamma: [1.02, 1.01, 0.965], gain: [0.900, 0.955, 1.085],
    warm: [0.935, 0.975, 1.075],
    sat: 0.98, contrast: 1.12, exposure: 0.80, vignette: 0.36, bloom: 0.78,
  },
  interior: {
    lift: [0.001, 0.000, 0.012], gamma: [1.00, 1.00, 1.00], gain: [1.030, 1.005, 0.965],
    warm: [1.080, 1.010, 0.885],
    sat: 1.10, contrast: 1.06, exposure: 0.96, vignette: 0.32, bloom: 0.55,
  },
  cinematic: {
    lift: [-0.014, -0.004, 0.017], gamma: [0.982, 1.000, 1.010], gain: [1.025, 1.008, 0.980],
    warm: [1.075, 1.010, 0.895],
    sat: 1.16, contrast: 1.13, exposure: 1.0, vignette: 0.34, bloom: 0.52,
  },
  studio: {
    lift: [-0.007, 0.000, 0.010], gamma: [1.00, 1.00, 0.990], gain: [1.012, 1.005, 0.995],
    warm: [1.040, 1.006, 0.955],
    sat: 1.08, contrast: 1.05, exposure: 1.0, vignette: 0.20, bloom: 0.40,
  },
};

const lin = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/* ------------------------------------------------------------------
   FILM GRAIN AMPLITUDE — §3.8 says 0.018, and this is not 0.018.
   Read the whole note before changing it back.

   Two independent judges in a blind side-by-side called this frame's
   grain "heavy" and "a heavy grain filter over the whole frame". It
   was measured rather than argued about: shoot the boot frame, take
   the high-frequency residual over a flat patch of sky (pixel minus
   the mean of its eight neighbours, divided by the sqrt(1 + 1/8) that
   operator adds to white noise), and shoot it again with each grain
   source switched off in turn. At 1600x900, on a patch of flat sky at
   luma 0.66:

     everything on                     sigma 0.01314
     .w-film hidden + uGrain 0         sigma 0.00111   <- the floor
     -> all grain, both sources              0.01314

   and the two sources separate as

     this shader at uGrain 0.011            0.00611
     src/ui/style.js `.w-film`              0.01163

   THIS SHADER IS INNOCENT, AND IT IS NOT THE LOUD ONE. The hash is
   uniform on -+0.5, so sigma = 0.577 * uGrain * lumaWeight, and the
   model was checked against a direct measurement of this pass alone
   (sigma 0.00866 at luma 0.59 against 0.00891 predicted — FXAA takes
   the difference). At the spec 0.018 this pass delivers sigma 0.00999
   at luma 0.66. That is a whisper.

   THE FRAME IS GRAINED TWICE, AND THE SECOND ONE IS BIGGER. `.w-film`
   in src/ui/style.js is a fixed, full-screen DOM layer — a 128 px
   noise tile, mix-blend-mode overlay, opacity 0.32 — lying over the
   entire canvas at z-index 30. On its own it measures sigma 0.01163,
   i.e. MORE than a correct film-grain pass, on top of a correct film
   grain pass. It is also STATIC and spatially clumped (the tile is
   cross-blurred and pinned to the viewport), and a grain that does not
   move is the loud one even when it is the quiet one: it reads as a
   filter laid over the picture instead of as emulsion in it. That is
   the thing the judges saw.

   `.w-film` belongs to the UI agent and is not ours to delete, and no
   value of uGrain can subtract it — it alone already exceeds spec. So
   this layer is pulled to 0.011, which is what a whole-frame budget of
   one spec pass leaves once 0.01163 of it has been spent elsewhere as
   far as it can be honoured: delivered total goes 0.01533 -> 0.01314,
   14 % down, and the ANIMATED half stays roughly half the energy,
   which is what keeps it reading as grain rather than as dirt on the
   lens. The frame cannot reach 0.018 until `.w-film` goes.

   WHEN `.w-film` IS REMOVED (or reduced to the DOM chrome surfaces it
   was actually written for — see the `G()` helper in style.js, which
   is the legitimate half of that file's grain), PUT THIS BACK TO
   0.018. It is one number and it is the spec.
   ------------------------------------------------------------------ */
export const GRAIN = 0.011;
export const GRAIN_SPEC = 0.018;

export function createPostFX(ctx, { composer }) {
  const renderer = ctx.renderer;
  const q = ctx.quality;

  let W = composer.width, H = composer.height;

  /* ---------------- shared uniforms ---------------- */
  const uTanHalfFov = { value: new THREE.Vector2(1, 1) };
  const uTime = { value: 0 };

  /* ================================================================
     0. NORMAL + DEPTH RESOLVE.

     THIS PASS REPLACES A WHOLE GEOMETRY PASS. The frame used to draw
     every mesh in the scene a second time into `main.nd` with a
     trivial shader, purely so SSAO and DOF could read a view normal
     and a linear depth. Measured in the Main Street fly-to at
     1600x900, that prepass was 547 draw calls and 4.58 ms of an
     11.7 ms render — more than the main forward pass itself, because
     at ~8 us of CPU per submitted draw this frame is bound by draw
     calls, not by pixels (halving the resolution moves it 0.3 ms).

     The main pass has already written all of that information into its
     own depth attachment. So the scene target now carries a real
     DEPTH_COMPONENT24 texture and this single full-screen pass
     un-projects it: linear metres straight into alpha, and a normal
     rebuilt from the depth gradient into RGB. The output buffer is
     bit-compatible with what the prepass wrote, so SSAO, DOF, the
     composite's circle-of-confusion and wally.js's ground-shadow
     projection all read it unchanged.

     The normal is rebuilt with the four-neighbour "closest wins"
     trick: on each axis the neighbour nearer in depth is the one that
     belongs to this surface, so a silhouette edge takes its gradient
     from the surface it is on rather than smearing across the
     discontinuity. The result is a geometric normal rather than the
     interpolated shading normal the prepass wrote — which for an
     occlusion term is the more correct input anyway, since a shading
     normal makes a low-poly cylinder occlude itself.

     A window depth of 1.0 is a pixel no geometry wrote (the sky dome
     has depthWrite off). Those become alpha 0, which is exactly the
     "this pixel is sky" convention the old buffer had, because the
     dome was flagged noPrepass and left the cleared zero behind.
     ================================================================ */
  const ndResolveMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tDepth;
    uniform vec2  uTexel;
    uniform vec2  uStep;
    uniform vec2  uNearFar;
    uniform vec2  uTanHalfFov;
    varying vec2 vUv;
    ${GLSL_VIEWPOS}
    ${GLSL_DEPTH}
    float rawZ( vec2 uv ) { return texture2D( tDepth, uv ).x; }
    void main() {
      float d = rawZ( vUv );
      if ( d >= 1.0 ) { gl_FragColor = vec4( 0.0 ); return; }
      float z = wLinearDepth( d, uNearFar );
      vec3 P = wViewPos( vUv, z, uTanHalfFov );

      vec2 ex = vec2( uStep.x, 0.0 );
      vec2 ey = vec2( 0.0, uStep.y );
      float zL = wLinearDepth( rawZ( vUv - ex ), uNearFar );
      float zR = wLinearDepth( rawZ( vUv + ex ), uNearFar );
      float zD = wLinearDepth( rawZ( vUv - ey ), uNearFar );
      float zU = wLinearDepth( rawZ( vUv + ey ), uNearFar );

      vec3 dx = abs( zR - z ) < abs( z - zL )
        ? wViewPos( vUv + ex, zR, uTanHalfFov ) - P
        : P - wViewPos( vUv - ex, zL, uTanHalfFov );
      vec3 dy = abs( zU - z ) < abs( z - zD )
        ? wViewPos( vUv + ey, zU, uTanHalfFov ) - P
        : P - wViewPos( vUv - ey, zD, uTanHalfFov );

      vec3 N = cross( dx, dy );
      float l = length( N );
      /* A perfectly flat run of depth (or the very edge of the frame)
         leaves a degenerate cross product; face the camera there
         rather than hand SSAO a NaN. */
      N = l > 1e-12 ? N / l : vec3( 0.0, 0.0, 1.0 );
      gl_FragColor = vec4( N * 0.5 + 0.5, z );
    }
  `, {
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uStep: { value: new THREE.Vector2() },
    uNearFar: { value: new THREE.Vector2(0.1, 1000) },
    uTanHalfFov,
  });

  /* ================================================================
     1. SSAO — wide radius, soft falloff, warm tint (§3.4)
     ================================================================ */
  const ssaoTaps = q.name === 'low' ? 8 : (q.name === 'med' ? 10 : 12);

  const ssaoMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tND;
    uniform vec2  uTexel;
    uniform vec2  uTanHalfFov;
    uniform float uRadius;
    uniform float uBias;
    uniform float uStrength;
    uniform float uMaxDist;
    varying vec2 vUv;
    ${GLSL_NOISE}
    ${GLSL_POISSON}
    ${GLSL_VIEWPOS}
    void main() {
      vec4 nd = texture2D( tND, vUv );
      float z = nd.a;
      if ( z <= 0.0 || z > uMaxDist ) { gl_FragColor = vec4( 1.0, z, 0.0, 1.0 ); return; }
      vec3 N = normalize( nd.rgb * 2.0 - 1.0 );
      vec3 P = wViewPos( vUv, z, uTanHalfFov );

      float rot = wHash12( gl_FragCoord.xy ) * 6.2831853;
      float cs = cos( rot ), sn = sin( rot );

      // screen-space footprint of a uRadius-metre sphere at this depth
      vec2 rUV = vec2( uRadius / ( 2.0 * z * uTanHalfFov.x ),
                       uRadius / ( 2.0 * z * uTanHalfFov.y ) );
      rUV = min( rUV, vec2( 0.16 ) );

      float occ = 0.0;
      float wsum = 0.0;
      for ( int i = 0; i < ${ssaoTaps}; i ++ ) {
        vec2 o = W_POISSON12[ i ];
        o = vec2( o.x * cs - o.y * sn, o.x * sn + o.y * cs );
        vec2 suv = vUv + o * rUV;
        vec4 snd = texture2D( tND, suv );
        float sz = snd.a;
        wsum += 1.0;
        if ( sz <= 0.0 ) continue;
        vec3 SP = wViewPos( suv, sz, uTanHalfFov );
        vec3 d = SP - P;
        float len = length( d );
        if ( len < 1e-4 ) continue;
        float ndl = max( dot( N, d / len ) - uBias, 0.0 );
        // soft, generous falloff: hard contact darkening is forbidden (§1.2)
        float atten = 1.0 - smoothstep( uRadius * 0.25, uRadius * 1.05, len );
        occ += ndl * atten;
      }
      occ /= max( wsum, 1.0 );
      float ao = clamp( 1.0 - occ * uStrength * 8.0, 0.0, 1.0 );
      /* Deepen rather than ease. The smoothstep that used to sit here
         pushed everything above ~0.7 straight back to 1.0, which is
         most of an ambient occlusion term — the pass was running and
         contributing almost nothing. A gamma keeps the falloff wide
         and soft (§1.2 forbids hard contact darkening) while letting
         the shallow end actually reach the frame. */
      ao = pow( ao, 1.7 );
      gl_FragColor = vec4( ao, z, 0.0, 1.0 );
    }
  `, {
    tND: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uTanHalfFov,
    uRadius: { value: 0.9 },
    uBias: { value: 0.035 },
    uStrength: { value: 0.55 },
    uMaxDist: { value: 90 },
  });

  const aoBlurMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tAO;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec2 c = texture2D( tAO, vUv ).rg;
      float z0 = c.g;
      float sum = c.r, wsum = 1.0;
      for ( int i = 1; i <= 4; i ++ ) {
        float fi = float( i );
        for ( int s = 0; s < 2; s ++ ) {
          vec2 o = uDir * fi * ( s == 0 ? 1.0 : -1.0 );
          vec2 t = texture2D( tAO, vUv + o ).rg;
          float w = exp( -fi * fi * 0.14 ) * ( 1.0 / ( 1.0 + abs( t.g - z0 ) * 3.0 ) );
          sum += t.r * w; wsum += w;
        }
      }
      gl_FragColor = vec4( sum / wsum, z0, 0.0, 1.0 );
    }
  `, { tAO: { value: null }, uDir: { value: new THREE.Vector2() } });

  const aoApplyMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform sampler2D tAO;
    uniform vec3 uAOTint;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tSrc, vUv );
      float ao = texture2D( tAO, vUv ).r;
      ao = mix( 1.0, ao, uAmount );
      c.rgb *= mix( uAOTint, vec3( 1.0 ), ao );
      gl_FragColor = c;
    }
  `, {
    tSrc: { value: null }, tAO: { value: null },
    // warm, never black — clay creases are #A9A5A2 against #D3D3D2 (§1.2)
    uAOTint: { value: new THREE.Vector3(0.42, 0.375, 0.36) },
    uAmount: { value: 1.0 },
  });

  /* ================================================================
     2. Bloom — HIGHLIGHT bloom, soft knee, N mips, warm (§3.5)

     THRESHOLD IS IN LINEAR HDR, NOT IN DISPLAY VALUES. §3.5 says
     "threshold 0.85" and that number was taken literally, but the
     prefilter runs on the linear scene buffer where a diffuse-lit
     surface already sits near 1.0 — the §2.1 horizon sky alone is
     0.912 in its blue channel. At 0.90 the bloom buffer was therefore
     a blurred copy of *the entire frame*, added back at 0.95, and the
     result was a milky veil that cost the palette a quarter of its
     chroma (sky S 0.330 -> 0.203, terracotta S 0.724 -> 0.553) and
     lifted every mid-tone 7-9 %. §2.1 asks for a high-saturation
     palette and §6 for bloom that is not overdone; a veil fails both.

     1.7 sits above the diffuse-lit ceiling of this lighting rig
     (sun + ambient is held near 1.0 by the exposure convention in
     toon.js, so the brightest plaster lands ~0.96) and below anything
     genuinely self-lit: lamp bulbs, window glass, the sun disc and
     its halo, and blown specular catches. Those bloom generously;
     nothing else blooms at all.
     ================================================================ */
  /* THE FLOOR IS 3, NOT 2, AND IT IS A SAFETY FLOOR RATHER THAN A
     LOOKS FLOOR. Read once, here, and never again: setQuality() does
     not rebuild the pyramid, so this is the only line that decides how
     big a bad texel gets smeared for the life of the page.

     A non-finite sample that gets past the guards below arrives on
     screen as a solid block roughly 2^(MIPS+1) px on a side —
     MEASURED, cold boot per tier: 94x106 at 3 mips, 206x218 at 4,
     428x432 at 5. tools/blacksquares.mjs is what catches that block in
     a frame, and its detection floor is a measured 36x36 (a 32x32
     plant arrives as 978 px against its MIN_PX of 1024, because FXAA
     and the grain erode the edge). At 2 mips the block is 38x42, area
     1554 — MEASURED on a tree built with this clamp and the low tier
     both at 2, not extrapolated from the halving, which predicted
     47x53 and was 20 % optimistic because the last mip's edge erodes
     too. 1.1x the detector's floor instead of 2.6x, only 1.5x its
     MIN_PX, and under both of its solid-pass side floors (SOLID_SIDE
     48, SQUARE_SIDE 72) — so at 2 mips one of the two detectors that
     watch for this block goes blind and the gate is down to detector
     1b alone.

     No shipped tier asks for fewer than 3 (contracts.js: 3/4/4/5) and
     blacksquares now FAILS if one does; this clamp is the same floor
     for a hand-built tier that never goes through QUALITY_TIERS. The
     cost of raising it from 2 is exactly zero on every shipped tier,
     and one extra quarter-res target on a tier that asked for less
     bloom than the detector can survive. */
  const MIPS = Math.max(3, q.bloomMips ?? 5);

  const bloomPreMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform float uThreshold;
    uniform float uKnee;
    uniform float uCeil;
    varying vec2 vUv;
    ${GLSL_COLOR}
    ${GLSL_FINITE}
    void main() {
      /* THE GATE INTO THE PYRAMID — see wFinite() in shaders.js.
         Everything past this line is smeared over 2^MIPS pixels, so
         this is the one place in the frame where a single rogue texel
         is worth six ALU to stop. A non-finite sample contributes
         nothing; a merely enormous one (a firefly on a specular
         catch, an emissive with a bad exponent) is capped rather than
         zeroed, so a genuinely bright highlight still blooms. */
      vec3 c = wFinite( texture2D( tSrc, vUv ).rgb, 0.0 );
      /* The ceiling is a SECOND, independent guard, and it has to come
         out with the first one or W_FINITE_OFF does not restore the
         pre-fix frame: clamp( +Inf, 0.0, 64.0 ) is a well-defined
         64.0, so the ceiling alone stops an Inf from ever reaching the
         pyramid. Measured — with only wFinite compiled out, an
         injected +Inf texel left bloom mip 0 completely clean and no
         square appeared. Both off is the frame the bug was reported
         in; both on is what ships. */
      #ifndef W_FINITE_OFF
      c = clamp( c, vec3( 0.0 ), vec3( uCeil ) );
      #endif
      float br = max( c.r, max( c.g, c.b ) );
      float knee = uThreshold * uKnee + 1e-5;
      float soft = clamp( br - uThreshold + knee, 0.0, 2.0 * knee );
      soft = soft * soft / ( 4.0 * knee );
      float contrib = max( soft, br - uThreshold ) / max( br, 1e-5 );
      gl_FragColor = vec4( c * contrib, 1.0 );
    }
  `, {
    tSrc: { value: null }, uThreshold: { value: 1.70 }, uKnee: { value: 0.50 },
    /* The sun disc and blown speculars sit in the low tens of linear
       units; 64 is far above anything the lighting rig produces and
       far below the 65504 a half-float can carry, so it only ever
       bites on a value that is already wrong. */
    uCeil: { value: 64.0 },
  });

  /* 13-tap Karis-weighted downsample: no fireflies, no shimmer. */
  const bloomDownMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    varying vec2 vUv;
    vec3 T( vec2 o ) { return texture2D( tSrc, vUv + o * uTexel ).rgb; }
    void main() {
      vec3 a = T( vec2( -2.0,  2.0 ) ), b = T( vec2( 0.0,  2.0 ) ), c = T( vec2( 2.0,  2.0 ) );
      vec3 d = T( vec2( -2.0,  0.0 ) ), e = T( vec2( 0.0,  0.0 ) ), f = T( vec2( 2.0,  0.0 ) );
      vec3 g = T( vec2( -2.0, -2.0 ) ), h = T( vec2( 0.0, -2.0 ) ), i = T( vec2( 2.0, -2.0 ) );
      vec3 j = T( vec2( -1.0,  1.0 ) ), k = T( vec2( 1.0,  1.0 ) );
      vec3 l = T( vec2( -1.0, -1.0 ) ), m = T( vec2( 1.0, -1.0 ) );
      vec3 o = e * 0.125;
      o += ( a + c + g + i ) * 0.03125;
      o += ( b + d + f + h ) * 0.0625;
      o += ( j + k + l + m ) * 0.125;
      gl_FragColor = vec4( o, 1.0 );
    }
  `, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

  /* 9-tap tent upsample, blended additively into the larger mip. */
  const bloomUpMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    uniform float uRadius;
    varying vec2 vUv;
    vec3 T( vec2 o ) { return texture2D( tSrc, vUv + o * uTexel * uRadius ).rgb; }
    void main() {
      vec3 o = T( vec2( 0.0, 0.0 ) ) * 4.0;
      o += ( T( vec2( -1.0, 0.0 ) ) + T( vec2( 1.0, 0.0 ) ) + T( vec2( 0.0, -1.0 ) ) + T( vec2( 0.0, 1.0 ) ) ) * 2.0;
      o += T( vec2( -1.0, -1.0 ) ) + T( vec2( 1.0, -1.0 ) ) + T( vec2( -1.0, 1.0 ) ) + T( vec2( 1.0, 1.0 ) );
      gl_FragColor = vec4( o / 16.0, 1.0 );
    }
  `, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 2.1 } });
  bloomUpMat.blending = THREE.AdditiveBlending;
  bloomUpMat.transparent = true;

  /* ================================================================
     3. DOF — bokeh gather at half res, near + far (§3.6)

     NEAR AND FAR NEED SEPARATE GAINS. The thin-lens term
     ( 1/focus - 1/z ) * aperture is unbounded as z -> 0 and saturates
     at aperture/focus as z -> infinity, so with a 11.5 m focus and
     a gameplay aperture the near CoC hits its -1 rail while the far
     CoC never gets past 0.21 — the near field blurred hard and the
     far field was measurably *identical* to a DOF-off render. §3.6
     requires near AND far. uFarGain re-normalises the far half so the
     background actually reaches uFarClamp, and uFarClamp (not the
     shared radius) is then the single knob that keeps the horizon
     legible (§2.4). The composite recomputes this CoC for its mix
     gate, so both gain and clamp have to be pushed there too.
     ================================================================ */
  const dofTaps = q.name === 'low' ? 8 : (q.name === 'med' ? 12 : 20);

  const dofMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform sampler2D tND;
    uniform vec2  uTexel;
    uniform float uFocus;
    uniform float uAperture;
    uniform float uMaxRadius;
    uniform float uFarClamp;
    uniform float uNearClamp;
    uniform float uFarGain;
    uniform float uAspect;
    varying vec2 vUv;
    ${GLSL_NOISE}
    ${spiralTaps(dofTaps)}

    float cocOf( float z ) {
      if ( z <= 0.0 ) z = 1e4;
      float c = ( 1.0 / uFocus - 1.0 / max( z, 0.05 ) ) * uAperture;
      if ( c > 0.0 ) c *= uFarGain;
      return clamp( c, - uNearClamp, uFarClamp );
    }
    void main() {
      float z0 = texture2D( tND, vUv ).a;
      float c0 = cocOf( z0 );
      float r = abs( c0 ) * uMaxRadius;
      vec3 sum = texture2D( tSrc, vUv ).rgb;
      float wsum = 1.0;
      float rot = wHash12( gl_FragCoord.xy ) * 6.2831853;
      float cs = cos( rot ), sn = sin( rot );
      for ( int i = 0; i < ${dofTaps}; i ++ ) {
        vec2 t = W_BOKEH[ i ];
        t = vec2( t.x * cs - t.y * sn, t.x * sn + t.y * cs );
        // near-field spreads outward, so always gather at the max of
        // this pixel's radius and the tap's own
        vec2 suv = vUv + t * vec2( r / uAspect, r );
        float sz = texture2D( tND, suv ).a;
        float cz = cocOf( sz );
        float w = clamp( abs( cz ) * uMaxRadius / max( r, 1e-5 ), 0.0, 1.0 );
        /* Foreground bleeds over sharp background, never the reverse —
           but only a foreground that is genuinely OUT of focus. The
           old test was step( 0.0, -cz ), which is true for anything
           one millimetre in front of the focal plane, so a roof at
           11.0 m with a 11.5 m focus was smearing itself ~8 px into
           the sky behind it and dissolving its own outline. Gate on a
           real near CoC instead of on the sign of one. */
        w = max( w, smoothstep( 0.03, 0.25, -cz ) );
        sum += texture2D( tSrc, suv ).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4( sum / wsum, 1.0 );
    }
  `, {
    tSrc: { value: null }, tND: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFocus: { value: 12 },
    uAperture: { value: 2.6 },
    uMaxRadius: { value: 0.0148 },
    uFarClamp: { value: 0.55 },
    /* THE NEAR SIDE NEEDS ITS OWN CEILING. ( 1/focus - 1/z ) is
       unbounded as z -> 0, so on a ground plane that runs from the
       camera's feet to the horizon the bottom of the frame always
       rails: every near CoC past ~0.42 delivers a fully blurred pixel,
       and §3.6 asks for "subtle in gameplay". The far side is clamped
       for legibility (§2.4); the near side is clamped so the surface
       the player is standing on stays readable. */
    uNearClamp: { value: 0.22 },
    uFarGain: { value: 1.9 },
    uAspect: { value: 1.777 },
  });

  /* ================================================================
     4. Composite — ACES, lift/gamma/gain, grain, vignette (§3.7-9)
     ================================================================ */
  const compositeMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tScene;
    uniform sampler2D tBloom;
    uniform sampler2D tDof;
    uniform sampler2D tND;
    uniform vec2  uResolution;
    uniform float uTime;
    uniform float uExposure;
    uniform vec3  uLift;
    uniform vec3  uGamma;
    uniform vec3  uGain;
    uniform vec3  uWarm;
    uniform float uSat;
    uniform float uContrast;
    uniform float uBloom;
    uniform vec3  uBloomTint;
    uniform float uGrain;
    uniform float uVignette;
    uniform vec3  uVigColor;
    uniform float uAspect;
    uniform float uFocus;
    uniform float uAperture;
    uniform float uFarClamp;
    uniform float uNearClamp;
    uniform float uFarGain;
    uniform float uDofMix;
    varying vec2 vUv;
    ${GLSL_NOISE}
    ${GLSL_COLOR}
    ${GLSL_FINITE}
    void main() {
      /* THE BACKSTOP. bloomPreMat keeps the pyramid clean, but this is
         the last pass before an UnsignedByte target, and a non-finite
         value written there is a black pixel with no way back. Each of
         the three inputs is scrubbed on its own so a bad one degrades
         to "that contribution is missing" rather than to "this pixel
         is void": no bloom halo, or no defocus, in a patch that still
         carries its own colour. */
      vec3 c = wFinite( texture2D( tScene, vUv ).rgb, 0.0 );

      // --- depth of field blend ---
      // must match cocOf() in dofMat exactly, gain and clamp included
      float z = texture2D( tND, vUv ).a;
      if ( z <= 0.0 ) z = 1e4;
      float coc = ( 1.0 / uFocus - 1.0 / max( z, 0.05 ) ) * uAperture;
      if ( coc > 0.0 ) coc *= uFarGain;
      coc = clamp( coc, - uNearClamp, uFarClamp );
      float k = smoothstep( 0.04, 0.42, abs( coc ) ) * uDofMix;
      /* A poisoned DOF gather falls back to the sharp pixel, which is
         what this pass does with dof off anyway. Note the VALUE has to
         be scrubbed as well as the weight zeroed: mix( c, NaN, 0.0 )
         is still NaN, because 0.0 * NaN is NaN. */
      vec3 dofC = texture2D( tDof, vUv ).rgb;
      float dofOk = ( wIsBad( dofC.r ) || wIsBad( dofC.g ) || wIsBad( dofC.b ) ) ? 0.0 : 1.0;
      c = mix( c, wFinite( dofC, 0.0 ), k * dofOk );

      // --- bloom ---
      c += wFinite( texture2D( tBloom, vUv ).rgb, 0.0 ) * uBloom * uBloomTint;

      // --- tone map ---
      c *= uExposure;
      c = wACES( c );

      // --- grade ---
      c = wLiftGammaGain( c, uLift, uGamma, uGain );

      /* Warm cream in the highlights (§3.7), weighted by luminance.
         Doing this with gain alone also drags every saturated
         mid-tone toward orange: gain.b = 0.93 took the #9FD8F2 sky
         with it and the sea-and-sky palette §2.1 is built on went
         grey. Gating on luma leaves saturated colour alone and only
         warms what is genuinely near the shoulder. */
      c *= mix( vec3( 1.0 ), uWarm, smoothstep( 0.55, 1.0, wLuma( c ) ) );

      c = wContrast( c, uContrast, 0.42 );
      c = wSaturate( c, uSat );

      // --- vignette: warm, soft, corners only ---
      // The old inner edge sat at 0.40 of a corner distance of ~0.93,
      // so two thirds of the falloff was off-frame and the visible
      // part topped out near 9%. Start it inside the safe area.
      float d = length( ( vUv - 0.5 ) * vec2( uAspect, 1.0 ) );
      float vig = smoothstep( 0.26, 0.98, d );
      c *= mix( vec3( 1.0 ), uVigColor, vig * uVignette );

      vec3 srgb = wLinearToSRGB( max( c, vec3( 0.0 ) ) );

      /* --- film grain (§3.8) ---
         Display-referred, not linear. 0.018 of a linear value is
         invisible anywhere the frame is bright — sRGB's slope up
         there is about 0.45, so it was landing at well under one
         8-bit code across the whole sky. Applied after encoding it is
         0.018 of a *code value* everywhere, which is what "matched to
         the clay's surface grain" needs to mean.

         wHash12 is uniform on [0,1), so g is uniform on -+0.5 and the
         term below has peak amplitude exactly uGrain * lumaWeight.

         THE LUMA WEIGHT IS NEARLY FLAT NOW. It used to be
         0.55 + 0.75*(1-L): x0.55 in the highlights, x1.30 in the
         shadows, so the delivered amplitude ranged 0.0099 to 0.0234
         against a spec that is a single number. And the bias ran the
         wrong way for a frame like this one — it put the MOST grain
         exactly where the eye looks for surface, in the dark HUD
         pills, in Wally's shaded side and under the eaves, which is
         the half of the frame the "heavy grain filter" note was
         about. 0.88 + 0.24*(1-L) keeps a whisper of the same idea
         (shadows a touch grainier than highlights, as emulsion is)
         inside +-12% of spec instead of -45/+30%. */
      float g = wHash12( vUv * uResolution + vec2( uTime * 137.13, uTime * 91.7 ) ) - 0.5;
      srgb += g * uGrain * 2.0 * ( 0.88 + 0.24 * ( 1.0 - wLuma( srgb ) ) );

      /* max() with a NaN operand is implementation-defined, so the
         clamp below is not on its own a guarantee. One last scrub. */
      gl_FragColor = vec4( wFinite( max( srgb, vec3( 0.0 ) ), 0.0 ), 1.0 );
    }
  `, {
    tScene: { value: null }, tBloom: { value: null }, tDof: { value: null }, tND: { value: null },
    uResolution: { value: new THREE.Vector2(W, H) },
    uTime,
    uExposure: { value: 1.0 },
    uLift: { value: new THREE.Vector3() },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uWarm: { value: new THREE.Vector3(1.06, 1.005, 0.905) },
    uSat: { value: 1.12 },
    uContrast: { value: 1.05 },
    uBloom: { value: 0.62 },
    uBloomTint: { value: new THREE.Vector3(1.06, 0.99, 0.90) },
    uGrain: { value: GRAIN },   // NOT 0.018 — see the GRAIN note above
    uVignette: { value: 0.22 },
    uVigColor: { value: new THREE.Vector3(0.55, 0.46, 0.40) },
    uAspect: { value: W / H },
    uFocus: { value: 12 },
    uAperture: { value: 2.6 },
    uFarClamp: { value: 0.55 },
    uNearClamp: { value: 0.22 },
    uFarGain: { value: 1.9 },
    uDofMix: { value: 1.0 },
  });

  /* ================================================================
     5. FXAA — after grading, on the encoded image (§3.10)
     ================================================================ */
  const fxaaMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    varying vec2 vUv;
    float L( vec3 c ) { return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }
    void main() {
      vec3 rgbM = texture2D( tSrc, vUv ).rgb;
      vec3 rgbNW = texture2D( tSrc, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
      vec3 rgbNE = texture2D( tSrc, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
      vec3 rgbSW = texture2D( tSrc, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
      vec3 rgbSE = texture2D( tSrc, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;

      float lM = L( rgbM ), lNW = L( rgbNW ), lNE = L( rgbNE ), lSW = L( rgbSW ), lSE = L( rgbSE );
      float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
      float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );
      float range = lMax - lMin;
      if ( range < max( 0.0312, lMax * 0.125 ) ) { gl_FragColor = vec4( rgbM, 1.0 ); return; }

      vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ), ( ( lNW + lSW ) - ( lNE + lSE ) ) );
      float dirReduce = max( ( lNW + lNE + lSW + lSE ) * 0.03125, 0.0078125 );
      float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
      dir = clamp( dir * rcpDirMin, -8.0, 8.0 ) * uTexel;

      vec3 rgbA = 0.5 * ( texture2D( tSrc, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb
                        + texture2D( tSrc, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
      vec3 rgbB = rgbA * 0.5 + 0.25 * ( texture2D( tSrc, vUv + dir * -0.5 ).rgb
                                      + texture2D( tSrc, vUv + dir *  0.5 ).rgb );
      float lB = L( rgbB );
      gl_FragColor = vec4( ( lB < lMin || lB > lMax ) ? rgbA : rgbB, 1.0 );
    }
  `, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

  /* ================================================================
     6. Buffer inspector. Every pass in this file is invisible when it
     is working and invisible when it is broken, which is how a whole
     post chain got shipped without anyone noticing SSAO was doing
     nothing. `WALLY.debug.buffer('ao')` puts an intermediate on the
     screen so the question is answerable in one screenshot.
     ================================================================ */
  const debugMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform int uMode;      // 0 rgb, 1 red as grey, 2 alpha/40 as grey
    varying vec2 vUv;
    void main() {
      vec4 s = texture2D( tSrc, vUv );
      vec3 c = uMode == 1 ? vec3( s.r ) : ( uMode == 2 ? vec3( s.a / 40.0 ) : s.rgb );
      gl_FragColor = vec4( c, 1.0 );
    }
  `, { tSrc: { value: null }, uMode: { value: 0 } });

  /* ================================================================
     7. THE NON-FINITE PROBE — how the black squares were caught.

     A single NaN or Inf pixel anywhere in the linear scene buffer does
     not stay a pixel. bloomPreMat divides by max(br,1e-5) where br is
     already NaN, the 13-tap downsample carries it into every mip, and
     the tent upsample carries it back — so one bad texel at mip 4 is a
     32x32 SCREEN-pixel block by the time the composite adds it, and a
     NaN through the composite is written to the LDR target as zero.
     That is the "random black square", and it is square because the
     mip pyramid is.

     A visual hunt cannot find the cause of that, only the symptom, and
     only once it is already big. This pass answers the actual
     question — "is any value in this buffer non-finite, and where" —
     by rendering a 1-bit map of the offending texels into a quarter-
     res byte target and reading it back.

     THE TEST HAS TO SURVIVE THE OPTIMISER. `v != v` and `!(v <= B)`
     are both legal for a compiler to fold away under a no-NaN
     assumption, so this uses THREE independent formulations OR'd
     together and ships a self-test (probeSelfTest below) that fills a
     buffer with a genuine runtime NaN — uK/uK from a uniform, which
     cannot be constant-folded — and asserts the probe sees it. If the
     self-test fails, the probe is lying and its zeroes mean nothing.
     ================================================================ */
  const nonFiniteMat = composer.makeMaterial(/* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uTexel;
    varying vec2 vUv;
    bool wBad( float v ) {
      /* NaN fails every comparison; +-Inf fails exactly one. Half
         float tops out at 65504 so 1e30 cannot flag a real value. */
      bool a = !( v <= 1e30 && v >= -1e30 );
      bool b = ( v != v );
      /* NaN*0 and Inf*0 are both NaN; finite*0 is exactly zero. */
      bool c = !( ( v * 0.0 ) == 0.0 );
      return a || b || c;
    }
    /* +-Inf still answers a magnitude comparison; NaN answers nothing.
       So bad-minus-inf is a NaN count, and the two have different
       causes — Inf is a divide by zero or an overflow, NaN is 0/0,
       Inf-Inf, or normalize() of a zero-length vector. */
    bool wInf( float v ) { return ( v > 1e30 ) || ( v < -1e30 ); }
    void main() {
      float hit = 0.0, inf = 0.0;
      for ( int y = 0; y < 4; y ++ ) {
        for ( int x = 0; x < 4; x ++ ) {
          vec2 o = ( vec2( float( x ), float( y ) ) - 1.5 ) * uTexel;
          vec4 s = texture2D( tSrc, vUv + o );
          if ( wBad( s.r ) || wBad( s.g ) || wBad( s.b ) || wBad( s.a ) ) hit = 1.0;
          if ( wInf( s.r ) || wInf( s.g ) || wInf( s.b ) || wInf( s.a ) ) inf = 1.0;
        }
      }
      gl_FragColor = vec4( hit, inf, 0.0, 1.0 );
    }
  `, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

  /* A runtime non-finite value, for the self-test. Everything here
     comes out of a uniform so none of it can be constant-folded, and
     three different producers are offered because which of them
     survives is a property of the driver, not of the language:

       0  uZero / uZero   -> NaN   (division by zero is UNDEFINED in
                                    GLSL ES; ANGLE/Metal compiles with
                                    fast math and may fold it to 0)
       1  1.0 / uZero     -> +Inf  (same caveat)
       2  uBig            -> +Inf  once the half-float target rounds
                                    1e30 up past 65504 on write, which
                                    is plain IEEE conversion and does
                                    not depend on shader fast math

     MEASURED, headless Chrome on Apple silicon (ANGLE -> Metal):

       mode 0  uZero / uZero  -> half bits 0x3c00 == 1.0    FOLDED
       mode 1  1.0  / uZero   -> half bits 0x7c00 == +Inf   SURVIVES
       mode 2  uBig (1e30)    -> half bits 0x7bff == 65504  CLAMPED

     So this driver both fast-maths 0/0 away AND clamps rather than
     overflowing to Inf on a half-float write — which is why mode 1 is
     the default. Re-run probeSelfTest(0..2) on any new machine before
     trusting a zero from the probe: which producer survives is a
     property of the driver, not of this file. */
  const nanFillMat = composer.makeMaterial(/* glsl */`
    uniform float uZero;
    uniform float uBig;
    uniform int uMode;
    varying vec2 vUv;
    void main() {
      float n = uMode == 0 ? ( uZero / uZero )
              : ( uMode == 1 ? ( 1.0 / uZero ) : uBig );
      gl_FragColor = vUv.x > 0.5 ? vec4( n ) : vec4( 0.25 );
    }
  `, { uZero: { value: 0 }, uBig: { value: 1e30 }, uMode: { value: 1 } });

  /* ---------------- targets ---------------- */
  const aoScale = 0.5;
  const dofScale = 0.5;

  const T = {
    a: composer.target('post.a', 1, {}),
    b: composer.target('post.b', 1, {}),
    ao: composer.target('post.ao', aoScale, { type: THREE.HalfFloatType }),
    ao2: composer.target('post.ao2', aoScale, { type: THREE.HalfFloatType }),
    dof: composer.target('post.dof', dofScale, {}),
    ldr: composer.target('post.ldr', 1, { type: THREE.UnsignedByteType }),
  };
  const mips = [];
  for (let i = 0; i < MIPS; i++) {
    mips.push(composer.target(`post.bloom${i}`, 1 / Math.pow(2, i + 1), {}));
  }

  /* ---------------- grade state (damped) ---------------- */
  const params = {
    exposure: 1.0,
    bloomScale: 1.0,
    ssao: q.ssao !== false,
    bloom: q.bloom !== false,
    dof: q.dof !== false,
    grain: q.grain !== false,
    fxaa: true,
    /* PIXELS between the depth samples the ND resolve fits its normal
       to, and it is not 1.

       At one texel the fit lands on whatever sub-pixel geometry is
       under the sample, and over the near grass carpet that is a
       different blade every pixel: the normal comes out random, every
       neighbouring blade then reads as an occluder to SSAO, and the
       field goes 22/255 darker in the AO buffer than the old geometry
       prepass made it (which wrote the card's own smooth normal and
       had no such problem). Measured against that prepass as the
       reference, over the whole Main Street frame with grain off:

         step 1   mean 1.67/255   near grass 4.68   6.8 % of pixels > 8
         step 2        1.57              4.28       5.5 %
         step 4        0.84              2.02       0.3 %
         step 6        0.52              1.02       0.2 %
         step 8        0.44              0.70       0.4 %

       Past 8 the near field keeps converging but the buildings start
       to drift the other way as the fit spans real curvature, so 6 is
       where both halves of the frame are inside one code value. The
       step is in pixels because the artefact is: a grass blade is a
       pixel or two wide whatever the resolution. */
    ndStep: 6,
    gradeName: 'day',
    debug: null,        // 'ao' | 'nd' | 'depth' | 'bloom' | 'dof' | 'scene'
  };

  const VEC3KEYS = ['lift', 'gamma', 'gain', 'warm'];
  const grade = { ...GRADES.day };
  for (const k of VEC3KEYS) grade[k] = [...GRADES.day[k]];
  let gradeTarget = grade;
  let gradeLambda = 0;

  function applyGradeUniforms(g) {
    const u = compositeMat.uniforms;
    u.uLift.value.fromArray(g.lift);
    u.uGamma.value.fromArray(g.gamma);
    u.uGain.value.fromArray(g.gain);
    u.uWarm.value.fromArray(g.warm);
    u.uSat.value = g.sat;
    u.uContrast.value = g.contrast;
    u.uExposure.value = g.exposure * params.exposure;
    u.uVignette.value = g.vignette;
    u.uBloom.value = g.bloom * params.bloomScale;
  }
  applyGradeUniforms(grade);

  /* ================================================================
     the frame
     ================================================================ */
  /* Build `ndRT` from the depth attachment of `sceneRT`. renderer.js
     calls this straight after the main forward pass, before render(). */
  function resolveND(sceneRT, ndRT, camera) {
    const dt = sceneRT.depthTexture;
    if (!dt) return false;
    const th = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    uTanHalfFov.value.set(th * camera.aspect, th);
    ndResolveMat.uniforms.tDepth.value = dt;
    ndResolveMat.uniforms.uTexel.value.set(1 / ndRT.width, 1 / ndRT.height);
    ndResolveMat.uniforms.uStep.value.set(
      params.ndStep / ndRT.width, params.ndStep / ndRT.height);
    ndResolveMat.uniforms.uNearFar.value.set(camera.near, camera.far);
    composer.draw(ndResolveMat, ndRT);
    return true;
  }

  function render(sceneRT, ndRT, camera, dt) {
    /* A public entry point does not trust its caller with a timestep.
       See the long note in renderer.js: one frame of negative dt
       through the grade easing below is enough to throw every grade
       uniform to +-1e5 and hand the player a black screen for the next
       ten seconds. Clamped here as well as at the source. */
    dt = dt > 0 ? Math.min(dt, 0.05) : 1 / 60;
    uTime.value = ctx.elapsed;

    /* camera-dependent uniforms */
    const th = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    uTanHalfFov.value.set(th * camera.aspect, th);
    compositeMat.uniforms.uAspect.value = camera.aspect;
    dofMat.uniforms.uAspect.value = camera.aspect;

    /* grade easing */
    if (gradeLambda > 0 && gradeTarget !== grade) {
      const l = gradeLambda, d = dt || 0.016;
      for (const k of VEC3KEYS) {
        for (let i = 0; i < 3; i++) grade[k][i] = damp(grade[k][i], gradeTarget[k][i], l, d);
      }
      for (const k of ['sat', 'contrast', 'exposure', 'vignette', 'bloom']) {
        grade[k] = damp(grade[k], gradeTarget[k], l, d);
      }
    }
    applyGradeUniforms(grade);

    let src = sceneRT;

    /* ---- 4. SSAO ---- */
    if (params.ssao) {
      ssaoMat.uniforms.tND.value = ndRT.texture;
      ssaoMat.uniforms.uTexel.value.set(1 / (W * aoScale), 1 / (H * aoScale));
      composer.draw(ssaoMat, T.ao);

      aoBlurMat.uniforms.tAO.value = T.ao.texture;
      aoBlurMat.uniforms.uDir.value.set(1.4 / (W * aoScale), 0);
      composer.draw(aoBlurMat, T.ao2);
      aoBlurMat.uniforms.tAO.value = T.ao2.texture;
      aoBlurMat.uniforms.uDir.value.set(0, 1.4 / (H * aoScale));
      composer.draw(aoBlurMat, T.ao);

      /* FOLDING THIS INTO THE COMPOSITE SAVES NOTHING — MEASURED, so
         it is still a pass. `scene *= tint(ao)` is a full-resolution
         RGBA16F read and write and looked like free money; the
         composite already samples this pixel and could do the multiply
         itself. Built it, A/B'd it in one boot at the Bent Spoon
         doorstep, 1600x900, high, GPU saturated (4 renders per rAF, so
         the clock cannot drop out from under the reading), 4 rounds:
         folded 9.99 ms, separate pass 9.89 ms — the fold is 0.10 ms
         SLOWER than the pass it deletes, inside a run-to-run spread of
         about 0.15. One dependent fetch and a branch in a full-res
         pass costs what a tile-resident full-res copy costs on this
         GPU. Reverted. */
      aoApplyMat.uniforms.tSrc.value = src.texture;
      aoApplyMat.uniforms.tAO.value = T.ao.texture;
      composer.draw(aoApplyMat, T.a);
      src = T.a;
    }

    /* ---- 5. bloom ---- */
    if (params.bloom) {
      bloomPreMat.uniforms.tSrc.value = src.texture;
      composer.draw(bloomPreMat, mips[0]);
      for (let i = 1; i < MIPS; i++) {
        bloomDownMat.uniforms.tSrc.value = mips[i - 1].texture;
        bloomDownMat.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
        composer.draw(bloomDownMat, mips[i]);
      }
      for (let i = MIPS - 1; i > 0; i--) {
        bloomUpMat.uniforms.tSrc.value = mips[i].texture;
        bloomUpMat.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
        composer.draw(bloomUpMat, mips[i - 1], false);
      }
      compositeMat.uniforms.tBloom.value = mips[0].texture;
    } else {
      compositeMat.uniforms.tBloom.value = null;
      compositeMat.uniforms.uBloom.value = 0;
    }

    /* ---- 6. DOF ---- */
    if (params.dof) {
      dofMat.uniforms.tSrc.value = src.texture;
      dofMat.uniforms.tND.value = ndRT.texture;
      dofMat.uniforms.uTexel.value.set(1 / (W * dofScale), 1 / (H * dofScale));
      composer.draw(dofMat, T.dof);
      compositeMat.uniforms.tDof.value = T.dof.texture;
      compositeMat.uniforms.uDofMix.value = 1;
    } else {
      compositeMat.uniforms.tDof.value = T.dof.texture;
      compositeMat.uniforms.uDofMix.value = 0;
    }

    /* ---- 7/8/9. composite ---- */
    compositeMat.uniforms.tScene.value = src.texture;
    compositeMat.uniforms.tND.value = ndRT.texture;
    compositeMat.uniforms.uResolution.value.set(W, H);
    compositeMat.uniforms.uGrain.value = params.grain ? (params.grainAmount ?? GRAIN) : 0;
    compositeMat.uniforms.uFocus.value = dofMat.uniforms.uFocus.value;
    compositeMat.uniforms.uAperture.value = dofMat.uniforms.uAperture.value;
    compositeMat.uniforms.uFarClamp.value = dofMat.uniforms.uFarClamp.value;
    compositeMat.uniforms.uNearClamp.value = dofMat.uniforms.uNearClamp.value;
    compositeMat.uniforms.uFarGain.value = dofMat.uniforms.uFarGain.value;

    if (params.debug) {
      const map = {
        ao: [T.ao.texture, 1], nd: [ndRT.texture, 0], depth: [ndRT.texture, 2],
        bloom: [mips[0].texture, 0], dof: [T.dof.texture, 0], scene: [sceneRT.texture, 0],
      };
      const e = map[params.debug];
      if (e) {
        debugMat.uniforms.tSrc.value = e[0];
        debugMat.uniforms.uMode.value = e[1];
        composer.draw(debugMat, null);
        return;
      }
    }

    if (params.fxaa) {
      composer.draw(compositeMat, T.ldr);
      fxaaMat.uniforms.tSrc.value = T.ldr.texture;
      fxaaMat.uniforms.uTexel.value.set(1 / W, 1 / H);
      composer.draw(fxaaMat, null);
    } else {
      composer.draw(compositeMat, null);
    }
  }

  /* ================================================================
     probe readback. Quarter res, one byte target, 4x4 taps per output
     texel so coverage is complete whatever the source size is.
     ================================================================ */
  let probeBuf = null;
  function probeRT() {
    return composer.target('post.probe', 0.25, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
  }
  /* Returns { bad, cells, at:[u,v] } for one texture. A GPU stall —
     debug only, never on a shipping frame. */
  function scanBuffer(tex, tw, th) {
    if (!tex) return null;
    const rt = probeRT();
    nonFiniteMat.uniforms.tSrc.value = tex;
    nonFiniteMat.uniforms.uTexel.value.set(1 / Math.max(1, tw), 1 / Math.max(1, th));
    composer.draw(nonFiniteMat, rt);
    const n = rt.width * rt.height * 4;
    if (!probeBuf || probeBuf.length !== n) probeBuf = new Uint8Array(n);
    renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, probeBuf);
    let bad = 0, inf = 0, fi = -1;
    for (let i = 0, p = 0; p < n; i++, p += 4) {
      if (probeBuf[p] > 127) { bad++; if (fi < 0) fi = i; if (probeBuf[p + 1] > 127) inf++; }
    }
    return {
      bad, inf, nan: bad - inf, cells: rt.width * rt.height,
      /* uv, with v measured from the BOTTOM — readRenderTargetPixels
         returns GL rows, so v 0.96 is four per cent from the top. */
      at: fi < 0 ? null : [+((fi % rt.width) / rt.width).toFixed(3),
        +(((fi / rt.width) | 0) / rt.height).toFixed(3)],
    };
  }

  /* ================================================================
     public surface
     ================================================================ */
  const api = {
    params,
    materials: { ndResolveMat, ssaoMat, aoApplyMat, bloomPreMat, dofMat, compositeMat, fxaaMat },
    render,
    resolveND,

    resize(w, h) {
      W = w; H = h;
      compositeMat.uniforms.uResolution.value.set(w, h);
    },

    /* focus in metres, aperture 0..10 (higher = shallower).
       farClamp caps how far the *background* is allowed to go — the
       horizon has to stay legible in gameplay (§2.4). farGain
       re-normalises the far half of the CoC curve, which otherwise
       saturates at aperture/focus and leaves the background sharp
       (see the dofMat comment). */
    setDOF(focus, aperture, farClamp, farGain, nearClamp) {
      if (focus !== undefined) dofMat.uniforms.uFocus.value = focus;
      if (aperture !== undefined) {
        dofMat.uniforms.uAperture.value = aperture;
        dofMat.uniforms.uMaxRadius.value = 0.008 + 0.028 * Math.min(1, aperture / 8);
      }
      if (farClamp !== undefined) dofMat.uniforms.uFarClamp.value = farClamp;
      if (farGain !== undefined) dofMat.uniforms.uFarGain.value = farGain;
      if (nearClamp !== undefined) dofMat.uniforms.uNearClamp.value = nearClamp;
    },

    setGrade(name, lambda = 0) {
      const g = GRADES[name] || GRADES.day;
      params.gradeName = name;
      if (lambda > 0) { gradeTarget = g; gradeLambda = lambda; return; }
      gradeTarget = g; gradeLambda = 0;
      for (const k of VEC3KEYS) grade[k] = [...g[k]];
      grade.sat = g.sat; grade.contrast = g.contrast; grade.exposure = g.exposure;
      grade.vignette = g.vignette; grade.bloom = g.bloom;
      applyGradeUniforms(grade);
    },

    /* Nudge individual grade knobs at runtime (debug / cutscenes). */
    tweak(o) { Object.assign(params, o); applyGradeUniforms(grade); },

    setSSAO(radius, strength) {
      if (radius !== undefined) ssaoMat.uniforms.uRadius.value = radius;
      if (strength !== undefined) ssaoMat.uniforms.uStrength.value = strength;
    },

    setBloom(threshold, strength) {
      if (threshold !== undefined) bloomPreMat.uniforms.uThreshold.value = threshold;
      if (strength !== undefined) params.bloomScale = strength;
    },

    setGrain(amount) { compositeMat.uniforms.uGrain.value = amount; params.grainAmount = amount; },
    setVignette(amount) { grade.vignette = amount; applyGradeUniforms(grade); },

    /* Put an intermediate buffer on screen. null restores the frame. */
    setDebug(name) { params.debug = name || null; },

    /* ---- the firewall, as an A/B switch ----
       Compiles wIsBad() out of the two materials that guard the frame
       (see GLSL_FINITE in shaders.js). OFF is the pre-fix build: the
       sky's stray NaN texel reaches bloomPreMat, the pyramid smears it
       over a few hundred pixels, and the composite writes it to the
       byte target as a black block. That is the whole reported bug, on
       demand, which is what makes it testable — tools/blacksquares.mjs
       --noguard asserts the block APPEARS, the plain gate asserts it
       does not. Two material recompiles; debug only. */
    setFiniteGuard(on) {
      const off = on === false;
      for (const m of [bloomPreMat, compositeMat]) {
        m.defines = m.defines || {};
        if (off) m.defines.W_FINITE_OFF = 1; else delete m.defines.W_FINITE_OFF;
        m.needsUpdate = true;
      }
      params.finiteGuard = !off;
      return !off;
    },

    /* ---- the non-finite probe (see section 7) ----
       Every buffer in the chain, in the order the frame builds them,
       so the FIRST one that reports `bad` is the one that made the
       NaN and everything after it merely inherited it. */
    probe(sceneRT, ndRT) {
      const r = {
        scene: scanBuffer(sceneRT.texture, sceneRT.width, sceneRT.height),
        nd: (params.ssao || params.dof) ? scanBuffer(ndRT.texture, ndRT.width, ndRT.height) : null,
        ao: params.ssao ? scanBuffer(T.ao.texture, T.ao.width, T.ao.height) : null,
        bloom0: params.bloom ? scanBuffer(mips[0].texture, mips[0].width, mips[0].height) : null,
        bloomN: params.bloom
          ? scanBuffer(mips[MIPS - 1].texture, mips[MIPS - 1].width, mips[MIPS - 1].height) : null,
        dof: params.dof ? scanBuffer(T.dof.texture, T.dof.width, T.dof.height) : null,
        ldr: params.fxaa ? scanBuffer(T.ldr.texture, T.ldr.width, T.ldr.height) : null,
      };
      r.any = Object.keys(r).some((k) => r[k] && r[k].bad > 0);
      return r;
    },

    /* Does the probe actually see a non-finite value on THIS driver?
       Fills the right-hand half of a HalfFloat buffer with one, reads
       the raw half-float bits back to prove it really landed, then
       asks the probe about the same buffer. `ok:false` means every
       other probe result on this machine is meaningless and must not
       be reported as "no NaNs found". */
    probeSelfTest(mode = 1) {
      nanFillMat.uniforms.uMode.value = mode;
      composer.draw(nanFillMat, T.a);
      /* Raw bits, right of centre. Half-float non-finite is
         exponent == 0x1F, i.e. (bits & 0x7C00) === 0x7C00. */
      const bits = new Uint16Array(4);
      let raw = null, landed = false;
      try {
        renderer.readRenderTargetPixels(
          T.a, Math.min(T.a.width - 1, (T.a.width * 0.75) | 0),
          (T.a.height * 0.5) | 0, 1, 1, bits);
        raw = '0x' + bits[0].toString(16);
        landed = (bits[0] & 0x7C00) === 0x7C00;
      } catch (e) { raw = 'readback failed: ' + e.message; }
      const r = scanBuffer(T.a.texture, T.a.width, T.a.height);
      const frac = r ? r.bad / r.cells : 0;
      return {
        ok: landed && frac > 0.3 && frac < 0.7,
        mode, landed, raw, frac: +frac.toFixed(3), ...r,
      };
    },

    dispose() {
      for (const m of Object.values(api.materials)) m.dispose();
      aoBlurMat.dispose(); bloomDownMat.dispose(); bloomUpMat.dispose();
      debugMat.dispose(); nonFiniteMat.dispose(); nanFillMat.dispose();
    },
  };

  return api;
}
