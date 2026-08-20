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
   TIME_OF_DAY sampling.

   The table is sparse (9 keyframes) and wraps: the last entry is
   t = 22 and the next one after it is t = 0. Hue is interpolated in
   HSL for the three *sky* colours, because a straight linear lerp
   from dusk orange to night navy passes through a dead grey — the
   one colour §2.1 forbids anywhere in the frame.
   ------------------------------------------------------------------ */
const _keyA = {}, _keyB = {};

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
     the 17:30 sky came out GREEN. A straight RGB lerp passes through
     a pale warm grey instead, which is what that hour actually looks
     like. */
  out.sky.copy(srgb(a.sky)).lerpHSL(srgb(b.sky), t);
  out.horizon.copy(srgb(a.horizon)).lerp(srgb(b.horizon), t);
  out.fog.copy(srgb(a.fog)).lerp(srgb(b.fog), t);
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
  function chromaOf(c) {
    const r = Math.pow(Math.max(c.r, 0), 0.45455);
    const g = Math.pow(Math.max(c.g, 0), 0.45455);
    const b = Math.pow(Math.max(c.b, 0), 0.45455);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx > 1e-4 ? (mx - mn) / mx : 0;
  }

  /* How much WARMER than cool a colour is, 0..1, gamma space. This is
     the number that decides whether the dome's vertical ramp is about
     to cross magenta: the boosted zenith is a blue with essentially no
     red in it, so any horizon whose red beats its blue puts a warm end
     and a cool end on the same straight line and every value between
     them has green as its smallest channel. Elevation is a proxy for
     that and a bad one — TIME_OF_DAY's horizon is still warm at 08:20,
     by which point the sun is 28 degrees up and every low-sun gate in
     this file has already switched off. Ask the colour, not the sun. */
  function warmthOf(c) {
    const r = Math.pow(Math.max(c.r, 0), 0.45455);
    const b = Math.pow(Math.max(c.b, 0), 0.45455);
    return r > 1e-4 ? clamp((r - b) / r, 0, 1) : 0;
  }

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

  /* Chooses a post grade from sun elevation. Crossfaded, never
     snapped: a grade change that lands in one frame reads as a cut. */
  function gradeFor(el, storm) {
    if (storm > 0.55) return 'dusk';
    if (el > 34) return 'day';
    if (el > 8) return 'golden';
    if (el > -5) return 'dusk';
    return 'night';
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
        const t = clamp(0.5 - 1.1 * dawn * dom, 0.12, 0.88);
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
