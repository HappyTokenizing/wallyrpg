/* ============================================================
   sky.js — ctx.sky. The dome, the sun, the moon, the stars, and the
   module that owns the primary light source for the whole game.

   ART_DIRECTION §2.1 / §2.4. The three things that decide whether a
   frame reads as Wind Waker or as a generic skybox:

   1. THE BAND. Zenith #2E7FD4 to horizon #9FD8F2 is only half the
      spec — "pales *dramatically* toward the sea line" is the other
      half. The pale band here is ~20 degrees tall, which at a 50
      degree FOV is most of the lower frame. A tight two-stop
      gradient is what every default skybox does and it is exactly
      what this must not look like.

   2. THE JOIN. scene.fog's colour and the dome's colour at h = 0 are
      the same value from the same source (lighting.js drives both
      from the TIME_OF_DAY `fog` entry, and the dome's bottom band
      resolves to exactly that colour). If they drift apart by even a
      few percent, the horizon shows a hard seam across the whole
      frame and no amount of haze hides it.

   3. THE SUN. Large soft disc, broad warm halo, and — when it is low
      or something breaks it — screen-space shafts. See lighting.js.

   Layout of the subsystem:
      lighting.js   TIME_OF_DAY -> key light, hemi fill, fog, grade,
                    exposure, god rays
      clouds.js     volumetric-reading cumulus on the wind field
      weather.js    clear/cloudy/rain/storm + the wet signal
      this file     the dome itself, the clock, and ctx.sky
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { SKY, SEA, SHADOW } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';
import { createLighting } from './lighting.js';
import { createClouds } from './clouds.js';
import { createWeather } from './weather.js';

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const DEG = Math.PI / 180;

const DOME_GLSL = /* glsl */`
  float sHash13( vec3 p3 ) {
    p3 = fract( p3 * 0.1031 );
    p3 += dot( p3, p3.zyx + 31.32 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
  float sHash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
  float sValue3( vec3 x ) {
    vec3 i = floor( x );
    vec3 f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix(
      mix( mix( sHash13( i ), sHash13( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
           mix( sHash13( i + vec3( 0.0, 1.0, 0.0 ) ), sHash13( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
      mix( mix( sHash13( i + vec3( 0.0, 0.0, 1.0 ) ), sHash13( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
           mix( sHash13( i + vec3( 0.0, 1.0, 1.0 ) ), sHash13( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
  }
`;

export async function init(ctx) {
  const scene = ctx.scene;
  const q = ctx.quality;

  /* ================================================================
     The dome
     ================================================================ */
  const uniforms = {
    uZenith:      { value: srgb(SKY.zenith) },
    uHorizon:     { value: srgb(SKY.horizon) },
    uHaze:        { value: srgb(SKY.haze) },
    /* THE MISSING STOP. See the dawn block in the fragment shader —
       lighting.js owns the colour, this is only where it lands. */
    uDawnMid:     { value: srgb(SKY.dawn) },
    uSunDisc:     { value: srgb(SKY.sunDisc) },
    uSunHalo:     { value: srgb(SKY.sunHalo) },
    uMoonColor:   { value: srgb(SEA.foam) },
    uStarColor:   { value: srgb(SEA.foam) },
    uMwColor:     { value: srgb(SKY.nightHorizon) },
    uStormTint:   { value: srgb(SHADOW.tint) },

    uSunDir:      { value: new THREE.Vector3(0.46, 0.72, 0.52) },
    uMoonDir:     { value: new THREE.Vector3(-0.4, 0.6, -0.6) },

    /* §2.1: "pales dramatically toward the sea line". uBandWidth is
       in sin(elevation), so 0.34 is a band ~20 degrees tall — most of
       the lower half of a level 50-degree frame. */
    uBandWidth:   { value: 0.34 },
    uBandPow:     { value: 1.5 },
    uBandAmt:     { value: 0.94 },
    uZenithPow:   { value: 0.85 },

    uSunSize:     { value: 0.021 },     // radians — a LARGE soft disc
    uDiscGain:    { value: 7.5 },
    uHaloWidth:   { value: 0.30 },
    uHaloAmt:     { value: 0.52 },
    uHorizonGlow: { value: 0.0 },
    uDawnAmt:     { value: 0.0 },

    uNight:       { value: 0 },
    uStorm:       { value: 0 },
    uFlash:       { value: 0 },
    uTime:        { value: 0 },
    /* ACES compensation happens in lighting.js as a chroma push on
       the three colours below (see boost() there), not as a gain
       here — a gain is what bleached the zenith to S 0.20. This
       stays at 1 and exists only as a knob. */
    uGain:        { value: 1.0 },
  };

  const domeMat = new THREE.ShaderMaterial({
    name: 'sky.dome',
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mv;
        /* pin to the far plane so no world geometry can ever be
           behind it and the depth buffer stays free for the prepass */
        gl_Position.z = gl_Position.w * 0.999999;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3  uZenith, uHorizon, uHaze, uSunDisc, uSunHalo, uDawnMid;
      uniform vec3  uMoonColor, uStarColor, uMwColor, uStormTint;
      uniform vec3  uSunDir, uMoonDir;
      uniform float uBandWidth, uBandPow, uBandAmt, uZenithPow;
      uniform float uSunSize, uDiscGain, uHaloWidth, uHaloAmt, uHorizonGlow, uDawnAmt;
      uniform float uNight, uStorm, uFlash, uTime, uGain;
      varying vec3 vDir;

${DOME_GLSL}

      void main() {
        vec3 d = normalize( vDir );
        float h = d.y;
        float hu = clamp( h, 0.0, 1.0 );

        /* ---- the gradient ----
           Two stages. The slow one climbs horizon -> zenith over the
           whole dome; the fast one lays a WIDE pale band over the
           bottom of it. The band is what the art direction calls the
           signature; a tight gradient reads as a generic skybox. */
        /* Away from a LOW sun the horizon colour has no business
           being there: TIME_OF_DAY's 18:00 horizon is #F2925C, and
           painting the whole visible sky with two thirds of it put a
           fluorescent orange behind the camera as well as in front of
           it. The warm band therefore decays with azimuth once the
           sun is low, and the climb into the zenith gets steeper at
           the same time, so sunset is orange where the sun is and
           blue-violet everywhere else. */
        vec2 azd = normalize( d.xz + vec2( 1e-5 ) );
        vec2 azs = normalize( uSunDir.xz + vec2( 1e-5 ) );
        float align = max( dot( azd, azs ), 0.0 );

        vec3 hor = mix( uHorizon, uZenith,
                        ( 1.0 - align ) * 0.62 * uHorizonGlow );
        float zp = mix( uZenithPow, uZenithPow * 0.58, uHorizonGlow );
        float t = pow( hu, zp );
        vec3 c = mix( hor, uZenith, t );

        /* ---- THE DAWN STOP, AND WHY A TWO-COLOUR RAMP CANNOT DO IT.

           This is what made 07:00 mauve, and it was never the haze.
           lighting.js boosts the zenith hard on purpose — ACES eats a
           cool colour's chroma, so #4B93D8 goes in as linear
           (0.00, 0.22, 1.22) with the RED CHANNEL AT ZERO. That is a
           fine sky on its own and renders as a proper blue at midday.
           Mixed with a peach horizon it is a disaster: red comes only
           from the peach and blue only from the zenith, green from
           neither, so every intermediate value has green as its
           SMALLEST channel. That is the definition of magenta. At the
           halfway point of the ramp it measured #C9B4DA. A lavender
           lid over the whole frame, with no gradient because every
           step of the ramp was the same washed violet.

           No amount of retuning the two ends fixes it: the fault is
           the straight line between them. A real dawn does not run
           peach -> blue, it runs peach -> a pale warm cream -> blue,
           and that middle stop is precisely the value with green in
           it. uDawnMid is that colour and lighting.js builds it from
           the same horizon/fog pair the band uses, so it can never
           disagree with what is underneath it.

           Azimuth-weighted, and legitimately so: this sits ABOVE the
           band, and the comment below is explicit that everything
           above the band may vary with azimuth because scene.fog only
           has to match the band. Toward the sun the warm stop runs at
           full strength and the sky is a dawn; away from it the ramp
           stays the plain two-colour climb and the sky behind you is
           blue, which is what a dawn actually looks like. ---- */
        if ( uDawnAmt > 0.002 ) {
          float dawnK = uDawnAmt * mix( 0.55, 1.0, align );
          /* BOTH STOPS SIT VERY LOW, AND THAT IS THE WHOLE TRICK.

             The cream is not a third of the sky, it is a seam. Spread
             any wider and the warm and the cool average out over the
             whole dome into exactly the violet the straight ramp gave
             — measured at a 0.30/0.72 placement the sky at 18 degrees
             was still #D6CCDA. So the cream owns t < 0.20 (the first
             ~7 degrees), hands over between 0.18 and 0.50, and from
             ~16 degrees up the dome is the zenith and nothing else.
             Peach, cream, blue, all of it inside the bottom quarter of
             the dome: three legible zones with a gradient between
             them, which is what §2.1 means by a dawn. */
          vec3 warm = mix( mix( hor, uDawnMid, smoothstep( 0.0, 0.20, t ) ),
                           uZenith, smoothstep( 0.18, 0.50, t ) );
          c = mix( c, warm, dawnK );
        }

        /* the band's height wobbles very slightly with azimuth, so it
           reads as atmosphere rather than as an analytic function */
        float az = atan( d.z, d.x );
        float wob = 1.0 + 0.14 * ( sValue3( vec3( cos( az ), sin( az ), 0.3 ) * 1.7 ) - 0.5 );
        float band = 1.0 - smoothstep( 0.0, uBandWidth * wob, hu );
        band = pow( band, uBandPow ) * uBandAmt;

        /* THE LAST DEGREE HAS TO BE EXACTLY uHaze.

           uBandAmt is 0.94, so this band tops out at 94% and the dome
           at h = 0 came out as 94% haze plus 6% of the horizon-to-
           zenith gradient. Fogged geometry converges on 100% haze.
           A 6% mismatch between the two is invisible at midday, when
           the haze and the gradient are both the same pale blue — and
           it is a hard horizontal line across the entire frame at
           dawn, when the haze is peach and the gradient behind it is
           violet. It sat exactly on the horizon, so it read as a seam
           in the world rather than as a bug in the sky.

           Forcing the band to a full 1.0 over the last ~1.7 degrees
           closes it. The band's shape everywhere else is untouched. */
        band = mix( band, 1.0, smoothstep( 0.03, 0.0, hu ) );

        /* THE BAND STAYS ONE COLOUR, DELIBERATELY.

           It is tempting to give this an azimuthal gradient — warm
           where the sun is, blue away from it — and it was tried.
           It cracks the horizon. scene.fog is a single colour and
           cannot have a gradient, so the only align it can be
           evaluated at is the camera's centre ray; across a 54 degree
           lens the edge pixels sit ~27 degrees off that, and at 07:00
           the two disagreed by ~8% of the haze-to-zenith delta. On
           something as flat as a sky that read as a hard horizontal
           step across the whole frame, exactly at the line where
           fogged geometry hands over to the dome.

           So the band is left flat and the mud it used to show at
           dawn is fixed at the source instead — lighting.js now
           resolves uHaze toward the saturated end of the horizon/fog
           pair rather than averaging a warm and a cool into the
           neutral §2.1 forbids. The directional warmth is carried by
           the hor term and the low-sun spread above, both of which
           sit ABOVE the band and are the dome's alone, so neither can
           drag the fog out of agreement. */
        c = mix( c, uHaze, band );

        /* below the sea line the dome is just haze, a touch deeper —
           the water module draws over most of it, but the join has to
           work in the gaps */
        c = mix( c, uHaze * 0.90, smoothstep( 0.0, -0.14, h ) );

        /* ---- sun ---- */
        float sd = clamp( dot( d, uSunDir ), -1.0, 1.0 );
        float ang = acos( sd );

        /* a broad warm halo (§2.1), then a tighter inner glow */
        float halo = exp( - ang / uHaloWidth );
        c = mix( c, uSunHalo, clamp( halo * uHaloAmt, 0.0, 0.95 ) * ( 1.0 - uStorm * 0.85 ) );
        c += uSunHalo * exp( - ang / ( uHaloWidth * 0.20 ) ) * 0.34 * ( 1.0 - uStorm );

        /* the low-sun spread: at dawn and dusk the glow runs ALONG
           the horizon, not in a circle around the disc */
        float spread = pow( align, 2.6 ) * ( 1.0 - smoothstep( 0.0, 0.34, abs( h ) ) );
        c = mix( c, uSunHalo, spread * uHorizonGlow );

        c *= uGain;

        /* the disc itself, added AFTER the gain and well past the
           bloom threshold so it blooms and nothing else does */
        float disc = 1.0 - smoothstep( uSunSize * 0.72, uSunSize, ang );
        c += uSunDisc * disc * uDiscGain * ( 1.0 - uStorm * 0.9 );

        /* ---- night ---- */
        if ( uNight > 0.002 ) {
          /* stars on a jittered 3D lattice over the view direction —
             stable in world space, so they do not swim as the camera
             turns, and they fade in with dusk rather than popping */
          vec3 sp = d * 210.0;
          vec3 ip = floor( sp );
          float hs = sHash13( ip );
          if ( hs > 0.9600 ) {
            vec3 jit = vec3( sHash13( ip + 1.7 ), sHash13( ip + 5.3 ), sHash13( ip + 11.9 ) ) - 0.5;
            float mag = ( hs - 0.9600 ) / 0.0400;
            float dd = length( sp - ( ip + 0.5 + jit * 0.66 ) );
            float tw = 0.62 + 0.38 * sin( uTime * ( 1.1 + mag * 3.4 ) + hs * 91.0 );
            float s = ( 1.0 - smoothstep( 0.0, 0.16 + mag * 0.30, dd ) ) * mag * tw;
            c += uStarColor * s * uNight * 3.2 * smoothstep( -0.03, 0.22, h );
          }

          /* a faint milky band, so the night sky has structure */
          float mw = exp( - pow( abs( dot( d, normalize( vec3( 0.42, 0.30, -0.86 ) ) ) ) * 3.1, 2.0 ) );
          mw *= 0.45 + 0.55 * sValue3( d * 7.0 );
          c += uMwColor * mw * uNight * 0.16 * smoothstep( -0.02, 0.3, h );

          /* the moon: disc with limb darkening and mare mottling,
             plus a wide soft halo */
          float md = clamp( dot( d, uMoonDir ), -1.0, 1.0 );
          float mang = acos( md );
          float ms = 0.047;
          float mdisc = 1.0 - smoothstep( ms * 0.88, ms, mang );
          float limb = sqrt( max( 1.0 - pow( mang / ms, 2.0 ), 0.0 ) );
          float mare = 0.80 + 0.34 * sValue3( d * 92.0 );
          c += uMoonColor * mdisc * mare * ( 0.62 + 0.44 * limb ) * uNight * 2.3;
          c += uMoonColor * exp( - mang / 0.13 ) * 0.22 * uNight;
        }

        /* ---- storm + lightning ---- */
        c = mix( c, uStormTint * 0.55, uStorm * 0.55 );
        c += ( uStarColor * 0.7 + uSunHalo * 0.3 ) * uFlash * ( 0.55 + 0.45 * ( 1.0 - hu ) );

        /* A gradient this large across a HalfFloat buffer will band
           on the way to 8 bits. One hash of dither costs nothing and
           the film grain in post hides the rest. */
        c += ( sHash12( gl_FragCoord.xy + fract( uTime ) * 91.0 ) - 0.5 ) * 0.0045;

        gl_FragColor = vec4( max( c, vec3( 0.0 ) ), 1.0 );
      }
    `,
  });

  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 32), domeMat);
  dome.name = 'sky.dome';
  dome.frustumCulled = false;
  dome.castShadow = false;
  dome.receiveShadow = false;
  dome.renderOrder = -1000;
  /* never in the prepass: the background must stay at depth 0 so
     SSAO ignores it, DOF treats it as infinitely far, and the god-ray
     pass can use "alpha == 0" to mean "sky" */
  dome.userData.noPrepass = true;
  dome.userData.noOutline = true;
  scene.add(dome);

  /* ================================================================
     Subsystems
     ================================================================ */
  const lighting = createLighting(ctx);
  const clouds = createClouds(ctx);
  const weather = createWeather(ctx);

  /* ================================================================
     Clock
     ================================================================ */
  /* THE OPENING HOUR.

     This was 10.5, and it was wrong in a way nothing in the frame
     announced. The game's own clock starts at 07:00 (game.js) and the
     intro hands the world over at 07:35 (intro/intro.js HOUR1) — but
     nothing bridges either of those to ctx.sky, and every screenshot
     sets skipIntro, so the boot frame rendered at this default while
     the HUD sat next to it reading "07:00 MORNING".

     The cost was the whole lighting read, and it was not that the
     shadows were missing — measured, the cascades were rendering the
     hero buildings correctly the entire time. It was that they were
     too SHORT to see. 10.5 samples the table at 48 degrees, which
     puts a building's shadow at 0.85x its own height: from a camera
     above eye level most of that run hides inside the footprint of
     the thing casting it, and what is left is a scrap at the wall
     line. Nothing in the frame said where the sun was.

     7.35 was tried for exactly that reason — a 15-degree key with a
     3.7x shadow run, sweeping 0.87 lateral to the default camera. The
     shadow geometry was right and the picture was still wrong: at that
     hour the horizon/fog blend lands between the t=7 dawn peach and the
     t=10 blue and delivers a flat mauve sky with no gradient, and the
     whole frame goes dim and low-contrast with it. Captured side by
     side, 7.35 and 8.5 are both washed and purple; 9.5 and 10.5 are
     blue and read properly.

     9.5 is the compromise, and it is an honest one: ~26 degrees of
     elevation, so roughly a 2x shadow run — shorter than dawn, still
     long enough to describe a building — with a sky that works. The
     right fix is to repair the dawn blend so a 7am opening is possible,
     since the game clock genuinely starts at 07:00; until then this is
     the hour that does not cost us the sky. */
  let hour = ctx.flags.hour != null && isFinite(ctx.flags.hour) ? ctx.flags.hour : 9.5;
  /* Frozen by default. BUILD_BRIEF: screenshots must be reproducible
     between builds, and a free-running clock makes every comparison
     shot a different time of day. The game module turns it on. */
  let timeScale = 0;
  /* Set by the bus subscription at the bottom of this file; null means
     "nobody is driving the clock". See THE DRIFT there. */
  let hourTarget = null;

  /* Scratch weather view — cloud cover eats the sun on top of
     whatever the weather state says. */
  const wx = { cloud: 0.3, sunMul: 1, ambMul: 1, fogMul: 0, storm: 0, rain: 0, flash: 0, exposureMul: 1 };

  function pump(dtRaw) {
    /* THE FIRST FRAME LIES. main.js takes `last = performance.now()`
       after the boot loop, but the requestAnimationFrame timestamp it
       subtracts from is the time the *frame* began — which, after a
       two-second boot, is already in the past. Measured: frame 1
       arrives with dt = -2.0355. Math.min(raw, 0.05) only clamps the
       top, so every damp() in the game gets a negative lambda*dt for
       one frame, i.e. exponential DIVERGENCE: the sun intensity here
       left 0.74 and landed at 0.187, the ambient went to -0.65, and
       the frame rendered as a flat grey wash for the two seconds it
       took to crawl back. Clamp it at the door; main.js is not ours
       to fix. */
    const dt = dtRaw > 0 ? (dtRaw < 0.05 ? dtRaw : 0.05) : 0;
    const st = weather.update(dt, lighting);
    wx.cloud = st.cloud;
    /* a cloud crossing the sun genuinely dims the world — the single
       cheapest piece of life a sky can have */
    wx.sunMul = st.sunMul * (1 - clouds.occlusion * 0.42);
    wx.ambMul = st.ambMul * (1 + clouds.occlusion * 0.10);
    wx.fogMul = st.fogMul;
    wx.storm = st.storm;
    wx.rain = st.rain;
    wx.flash = st.flash;
    wx.exposureMul = st.exposureMul;

    lighting.update(dt, hour, wx);
    clouds.update(dt, ctx.elapsed, lighting.sunDirection, lighting, wx);

    /* ---- dome uniforms ---- */
    uniforms.uZenith.value.copy(lighting.skyOut);
    uniforms.uHorizon.value.copy(lighting.horizonOut);
    /* THE JOIN: the dome's bottom band IS the fog colour. Not close
       to it — the same value, from the same boosted source. */
    uniforms.uHaze.value.copy(lighting.fogOut);
    uniforms.uSunHalo.value.copy(lighting.haloOut);
    uniforms.uSunDir.value.copy(lighting.sunDirection);
    uniforms.uMoonDir.value.copy(lighting.moonDirection);
    uniforms.uNight.value = lighting.night;
    uniforms.uStorm.value = wx.storm;
    uniforms.uFlash.value = wx.flash;
    uniforms.uTime.value = ctx.elapsed;

    /* the low-sun horizon spread, and a disc that grows and reddens
       as it sets — both driven by elevation, both off by mid-morning */
    const el = lighting.tod.sunEl;
    /* "low sun" has to reach up into golden hour, not just to the
       moment of sunset: at el 17 the old -6..20 ramp gave 0.06 and
       the warm horizon spread was effectively off for the whole hour
       that most exterior shots will be taken in. */
    const low = 1 - smoothstep(-8, 32, el);
    /* Read, not recomputed: the band above, the horizon spread below
       and scene.fog's join all key off this one number, and the fog
       lives in lighting.js. Two copies of the same expression is how
       the horizon cracks. */
    uniforms.uHorizonGlow.value = lighting.horizonGlow;
    uniforms.uSunSize.value = lerp(0.020, 0.031, low);
    uniforms.uHaloWidth.value = lerp(0.26, 0.44, low);
    uniforms.uHaloAmt.value = lerp(0.46, 0.66, low) * (1 - wx.cloud * 0.30);
    uniforms.uDiscGain.value = lerp(5.6, 3.0, low) * clamp(1 - wx.cloud * 0.55, 0, 1);
    /* overcast flattens the gradient: the band widens and the zenith
       stops being a different colour from the horizon */
    uniforms.uBandWidth.value = lerp(0.34, 0.52, wx.cloud);
    uniforms.uBandAmt.value = lerp(0.94, 0.80, wx.cloud);

    /* THE BAND HAS TO GET OUT OF THE WAY AT DAWN.

       §2.1's "pales dramatically toward the sea line" is a MIDDAY
       instruction: at noon the haze and the zenith are both blue, so a
       band 25 degrees tall reads as depth. At 07:21 the haze is peach
       and the zenith is #4B93D8, and a 25-degree band with uBandAmt
       0.88 means the bottom 25 degrees of sky is 88 % peach — which
       with the camera pitched down is very nearly all the sky in
       frame. The horizon colour ate the sky and what was left, half
       warm and half cool, averaged to the mauve.

       Rather than narrow the band (which would move the join, and the
       join is the one thing in this file that must not move), the
       EXPONENT goes up. The band is still exactly 1.0 at h = 0 and
       still exactly uBandAmt-shaped at midday; at dawn it just falls
       off far faster, so the peach hugs the sea line and the blue
       comes all the way down to meet it. That is a gradient, which is
       what was missing.

       glow01 is horizonGlow renormalised out of its 0..0.8 range —
       lighting.js owns that number and this must not recompute it. */
    /* lighting.js owns the dawn factor — read, never recomputed, for
       the same reason horizonGlow is (the fog has to agree with it). */
    const dawn = lighting.dawn;
    uniforms.uBandPow.value = lerp(1.5, 3.4, dawn);
    uniforms.uBandWidth.value *= lerp(1.0, 0.86, dawn);
    uniforms.uDawnAmt.value = dawn;
    uniforms.uDawnMid.value.copy(lighting.dawnMid);

    /* keep the dome on the camera */
    const cam = ctx.camera;
    if (cam) dome.position.copy(cam.position);
  }

  /* one pump before the first frame so nothing renders a default sky */
  pump(1 / 60);

  /* ================================================================
     ctx.sky
     ================================================================ */
  const api = {
    /* --- objects --- */
    dome, domeMaterial: domeMat,
    clouds, weather, lighting,
    lights: lighting.lights,
    key: lighting.key,
    hemi: lighting.hemi,
    fog: lighting.fog,
    uniforms: {
      ...uniforms,
      uWetness: weather.uniforms.uWetness,
    },

    /* --- live state other modules read --- */
    sunDirection: lighting.sunDirection,     // surface -> sun
    moonDirection: lighting.moonDirection,
    sunColor: lighting.sunColor,
    ambientColor: lighting.ambientColor,
    fogColor: lighting.fogColor,
    skyColor: lighting.skyColor,
    horizonColor: lighting.horizonColor,

    get exposure() { return lighting.exposure; },
    get isNight() { return lighting.isNight; },
    get night() { return lighting.night; },
    get hour() { return hour; },
    get sunElevation() { return lighting.tod.sunEl; },
    get weatherName() { return weather.name; },
    get wetness() { return weather.wetness; },
    get cloudCover() { return wx.cloud; },
    get sunOcclusion() { return clouds.occlusion; },
    get grade() { return lighting.grade; },

    /* --- control --- */
    setHour(h) {
      hourTarget = null;                 // an explicit set wins
      hour = ((Number(h) % 24) + 24) % 24;
      /* settle the damped scalars so a debug jump is not a two-second
         fade the screenshot catches half way through */
      for (let i = 0; i < 40; i++) pump(1 / 30);
      ctx.render?.setGrade(lighting.grade, 0);
      ctx.bus.emit('sky:hour', hour);
      return hour;
    },

    /* fade is in SECONDS and defaults to two and a half minutes.
       "Transitions take minutes, never snap." */
    setWeather(name, fade = 150) {
      const ok = weather.set(name, fade);
      if (ok && fade <= 0) for (let i = 0; i < 40; i++) pump(1 / 30);
      return ok;
    },

    /* hours of game time per second of real time. 0 freezes it. */
    setTimeScale(s) { timeScale = Number(s) || 0; return timeScale; },
    get timeScale() { return timeScale; },

    /* --- frame --- */
    update(dt) {
      /* Follow the game clock if it has moved. Eased, not snapped: the
         game advances time in jumps (a bus ride is 40 minutes) and a
         hard cut of the sky is the one thing a time-of-day system must
         never do. 0.55 lambda settles a one-hour step in about four
         seconds, which reads as the sun moving. */
      if (hourTarget != null) {
        let d = ((hourTarget - hour + 36) % 24) - 12;   // shortest arc
        if (Math.abs(d) < 0.004) { hour = hourTarget; hourTarget = null; }
        else hour = (hour + d * (1 - Math.exp(-0.55 * Math.min(dt, 0.05))) + 24) % 24;
      } else if (timeScale !== 0) {
        hour = (hour + dt * timeScale) % 24;
      }
      pump(dt);
    },

    resize(w, h) { lighting.resize(w, h); },

    dispose() {
      offHour?.();
      offDay?.();
      scene.remove(dome);
      dome.geometry.dispose();
      domeMat.dispose();
      clouds.dispose();
      weather.dispose();
      lighting.dispose();
    },
  };

  /* ================================================================
     THE DRIFT — the HUD clock and the sky were two different times.

     game.js owns st.time and emits `hour` on every hour boundary with
     the minute count; ui/hud reads the same state. Nothing bridged
     either of them to ctx.sky, so the HUD could read 14:00 while the
     sun sat wherever the sky's own default or the last debug setHour
     had left it. Half a day apart is possible and it happened.

     Subscribed here rather than pushed from game.js because ctx.sky is
     ours and game/* is not: this is the module contract's "talk over
     ctx.bus" case exactly.

     It deliberately does NOT adopt the clock at boot. Every screenshot
     runs with skipIntro and no input, so the game clock never advances
     in one, and BUILD_BRIEF requires those frames to be reproducible;
     the opening hour therefore stays a decision made in one place —
     the default a few lines above — rather than an emergent
     consequence of game.js's start time. Once time actually moves, the
     sky follows it and never drifts again.
     ================================================================ */
  const offHour = ctx.bus.on('hour', (e) => {
    const m = Number(e?.minutes);
    const h = isFinite(m) ? (m / 60) : Number(e?.hour);
    if (!isFinite(h)) return;
    hourTarget = ((h % 24) + 24) % 24;
  });
  const offDay = ctx.bus.on('day', () => { hourTarget = null; });

  /* ================================================================
     Debug hooks
     ================================================================ */
  const dbg = (window.WALLY && window.WALLY.debug) || {};

  /* While core/camera.js is still a stub nothing owns ctx.camera, so
     a setHour in a screenshot would frame whatever main.js left
     pointing north. Aim at the sun instead — and stop doing it the
     moment the camera agent ships, because then the camera has an
     owner and it is not us. */
  function freeCamera() {
    /* core/camera.js owns ctx.camera once it ships. It exposes
       setEnabled(false), which is the sanctioned way to take it —
       nothing here ever fights the rig for the transform. */
    if (ctx.cam?.setEnabled) ctx.cam.setEnabled(false);
  }

  function aimAtSun(pitchDeg = 9, dist = 46, flip = false) {
    const cam = ctx.camera;
    if (!cam) return;
    freeCamera();
    const d = lighting.sunDirection;
    const az = Math.atan2(d.x, d.z) + (flip ? Math.PI : 0);
    const t = Math.tan(pitchDeg * DEG) * 10;
    /* Well clear of the island: at eye height the frame is mostly
       grass cards and the sky is not what is being judged. */
    cam.position.set(-Math.sin(az) * dist, 24, -Math.cos(az) * dist);
    cam.lookAt(
      cam.position.x + Math.sin(az) * 10,
      cam.position.y + t - 1.2,
      cam.position.z + Math.cos(az) * 10
    );
    cam.updateMatrixWorld();
  }

  dbg.setHour = (h) => { const v = api.setHour(h); pump(1 / 60); return v; };
  dbg.setWeather = (n, f = 0) => { const ok = api.setWeather(n, f); pump(1 / 60); return ok; };
  dbg.timeScale = (s) => api.setTimeScale(s);
  /* 'sun'  aim at the sun's azimuth, slightly up — the framing that
             shows the disc, the halo and the shafts
     'up'    30 degrees of pitch, for judging the zenith and the
             clouds overhead
     'horizon' dead level, for judging the band and the fog join
     anything else hands the camera back to the rig. */
  dbg.skyCam = (mode, pitch) => {
    const cam = ctx.camera;
    if (!cam) return null;
    if (mode === 'sun') { aimAtSun(pitch ?? 9); pump(1 / 60); return 'sun'; }
    if (mode === 'up') { aimAtSun(pitch ?? 32); pump(1 / 60); return 'up'; }
    if (mode === 'horizon') { aimAtSun(pitch ?? 0); pump(1 / 60); return 'horizon'; }
    if (mode === 'anti') { aimAtSun(pitch ?? 40, 46, true); pump(1 / 60); return 'anti'; }
    ctx.cam?.resume?.();
    ctx.cam?.follow?.();
    return 'follow';
  };
  dbg.sky = () => ({
    hour: +hour.toFixed(2),
    weather: weather.name,
    sunEl: +lighting.tod.sunEl.toFixed(1),
    sunDir: lighting.sunDirection.toArray().map((v) => +v.toFixed(3)),
    sunI: +lighting.sunIntensity.toFixed(3),
    ambI: +lighting.ambientIntensity.toFixed(3),
    exposure: +lighting.exposure.toFixed(3),
    grade: lighting.grade,
    night: +lighting.night.toFixed(3),
    isNight: lighting.isNight,
    cloud: +wx.cloud.toFixed(3),
    occ: +clouds.occlusion.toFixed(3),
    wetness: +weather.wetness.toFixed(3),
    fog: [lighting.fog.near | 0, lighting.fog.far | 0],
    godrays: +(lighting.godrays?.uniforms.uStrength.value ?? 0).toFixed(3),
  });
  /* The lighting rig measured against the CAMERA, which is the only
     frame of reference in which "you can tell where the sun is" means
     anything. `run` is the shadow's length as a multiple of the
     caster's height; `across` is how much of that run is lateral on
     screen (1 = straight across the frame, 0 = straight into or out
     of it) and is the number that decides whether a shadow is
     legible or hidden behind its own building. `toward` is positive
     when shadows fall toward the viewer. */
  dbg.lightRig = () => {
    const cam = ctx.camera;
    const d = lighting.sunDirection;
    const el = lighting.tod.sunEl;
    const run = el > 0.4 ? 1 / Math.tan(el * DEG) : Infinity;
    const out = { hour: +hour.toFixed(2), sunEl: +el.toFixed(1),
      sunAz: +(Math.atan2(d.x, d.z) / DEG).toFixed(1),
      run: isFinite(run) ? +run.toFixed(2) : null };
    if (cam) {
      const f = new THREE.Vector3();
      cam.getWorldDirection(f);
      const fl = Math.hypot(f.x, f.z) || 1e-5;
      const fx = f.x / fl, fz = f.z / fl;
      /* shadow direction on the ground = away from the sun */
      const sl = Math.hypot(d.x, d.z) || 1e-5;
      const sx = -d.x / sl, sz = -d.z / sl;
      /* camera right on the ground plane */
      out.camAz = +(Math.atan2(fx, fz) / DEG).toFixed(1);
      out.across = +(sx * fz - sz * fx).toFixed(3);
      out.toward = +(-(sx * fx + sz * fz)).toFixed(3);
    }
    return out;
  };
  if (window.WALLY) window.WALLY.debug = dbg;

  return api;
}
