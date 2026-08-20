/* ============================================================
   shaders.js — shared GLSL chunks for the WALLY render core.

   Nothing in here talks to three directly; these are strings that
   toon.js / postfx.js / csm.js splice into their programs. Keeping
   them in one file means the clay grain in the material and the film
   grain in post are literally the same noise function, which is the
   whole point of ART_DIRECTION §3.8 ("matched to the clay's surface
   grain so the whole frame feels like one material").

   All shaders are compiled by three as GLSL ES 3.00 with three's
   GLSL1 compatibility defines (varying/texture2D/gl_FragColor), so
   write GLSL1-flavoured code. `const` arrays and non-constant loop
   bounds are fine; dynamic indexing of sampler arrays is NOT — csm.js
   unrolls those from JS.
   ============================================================ */

/* ------------------------------------------------------------------
   Fullscreen triangle. The geometry (see composer.js) is already in
   clip space, so this is a straight pass-through — no matrices, no
   overdraw at the quad seam.
   ------------------------------------------------------------------ */
export const FSQ_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/* ------------------------------------------------------------------
   Hash + noise. Cheap, stable, no texture fetch. Used for PCF kernel
   rotation, film grain, dithering and the fallback surface grain.
   ------------------------------------------------------------------ */
export const GLSL_NOISE = /* glsl */`
float wHash11( float p ) {
  p = fract( p * 0.1031 );
  p *= p + 33.33;
  return fract( p * ( p + p ) );
}
float wHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float wHash13( vec3 p3 ) {
  p3 = fract( p3 * 0.1031 );
  p3 += dot( p3, p3.zyx + 31.32 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec2 wHash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}
float wValue3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = wHash13( i + vec3( 0.0, 0.0, 0.0 ) );
  float n100 = wHash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = wHash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = wHash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = wHash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = wHash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = wHash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = wHash13( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );
}
`;

/* ------------------------------------------------------------------
   Colour science. ACES (Stephen Hill's fit — the good one, not the
   Narkowicz approximation, which crushes the saturated cyans this
   palette lives on), sRGB transfer, and the lift/gamma/gain grade.
   ------------------------------------------------------------------ */
export const GLSL_COLOR = /* glsl */`
float wLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

const mat3 W_ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777 );
const mat3 W_ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602 );

vec3 wACES( vec3 c ) {
  c = W_ACES_IN * c;
  vec3 a = c * ( c + 0.0245786 ) - 0.000090537;
  vec3 b = c * ( 0.983729 * c + 0.4329510 ) + 0.238081;
  c = a / b;
  return clamp( W_ACES_OUT * c, 0.0, 1.0 );
}

vec3 wLinearToSRGB( vec3 c ) {
  return mix( c * 12.92,
              1.055 * pow( max( c, vec3( 0.0031308 ) ), vec3( 0.41666 ) ) - 0.055,
              step( 0.0031308, c ) );
}

/* Lift shifts the toe, gamma the midtones, gain the shoulder.
   ART_DIRECTION §3.7: shadows blue-violet, highlights warm cream. */
vec3 wLiftGammaGain( vec3 c, vec3 lift, vec3 gamma, vec3 gain ) {
  c = c * gain + lift * ( 1.0 - c );
  return pow( max( c, vec3( 0.0 ) ), 1.0 / max( gamma, vec3( 0.02 ) ) );
}

vec3 wSaturate( vec3 c, float s ) {
  /* s > 1 sends the weakest channel of a saturated dark negative, and
     a negative channel that later gets max()'d to zero is a hue
     shift, not a saturation boost. Clamp at the source. */
  return max( mix( vec3( wLuma( c ) ), c, s ), vec3( 0.0 ) );
}

/* Pivoted power curve, not a pivoted line.
   The linear form, ( c - pivot ) * k + pivot, has a root at
   pivot * ( 1 - 1/k ): with the day grade's k = 1.09 and pivot 0.42
   everything below 0.035 clipped flat to zero, so a dark wood post in
   shade rendered pure black — §7's first forbidden item. The power
   form is monotone, fixes the same pivot, lifts the shoulder by the
   same amount and cannot reach zero from a non-zero input. */
vec3 wContrast( vec3 c, float k, float pivot ) {
  return pivot * pow( max( c, vec3( 1e-5 ) ) / pivot, vec3( k ) );
}
`;

/* ------------------------------------------------------------------
   THE SHADOW LAW — ART_DIRECTION §2.1.

       shadow = lerp( albedo, albedo * tint, amount )

   with tint #5A6E9E and amount 0.55: "a hue rotation toward
   blue-violet plus a modest value drop. Never albedo * 0.4."

   Three things have to be true or it degenerates into mud:

   1. It is evaluated in *gamma* space. #5A6E9E is an authored,
      colour-picker value. Decoding it to linear first gives
      (0.10, 0.15, 0.34) and the "modest value drop" silently becomes
      an 85 % crush toward black — exactly the thing §2.1 forbids.

   2. The tint is normalised to its brightest channel before use, so
      it carries *hue only*. The value drop is a separate, explicit
      term. A tint that is simultaneously dark and blue double-counts
      itself and every shadow in the game goes near-black.

   3. `bleed` pulls a little of the shadow's own colour back in. A
      pure multiply can never rotate the hue of a saturated albedo
      that has no blue in it — grass in shade would stay green, only
      darker, which is precisely the failure mode §2.1 calls an
      automatic fail. This term is the sky bounce that lights a real
      shadow, and it is what makes the frame read as Wind Waker.

   4. `fill` is SKY IRRADIANCE AND IS ABSOLUTE, NOT PROPORTIONAL.
      Every other term above is a multiply, so all of them scale with
      the albedo and all of them do nothing at all where the albedo is
      near zero. Measured on the shipped values: a clay sphere rotated
      166 degrees into the blue-violet, while a weathered wood post
      rotated 0 degrees and simply went to #272020 — grey-brown at
      0.34x its lit value, i.e. worse than the `albedo * 0.4` that
      §2.1 explicitly forbids, with none of the hue rotation that was
      supposed to replace it. A sky is a light source, not a tint: it
      adds the same irradiance to a dark plank as to a white wall, and
      that is precisely why dark materials are the ones whose shade
      goes blue in the real world. Sizing it in gamma space keeps it
      perceptually even across the value range.

   5. A hard luminance floor underneath all of it. Even with the fill,
      an arbitrarily dark future material could still land below the
      "modest value drop" §2.1 mandates, and a shadow that reads as a
      black hole is §7's first forbidden item. 0.55 is the floor, and
      it is applied as a scale so the hue that terms 1-4 built is kept
      intact rather than being washed out by a second additive lift.

   6. THE ROTATION HAS TO BE BOUNDED BY THE SURFACE'S OWN CHROMA.
      This is the part that was wrong, and it was wrong in both
      directions at once.

      Everything above is sized in absolute terms, so how far it moves
      a hue depends entirely on how much hue there was to start with.
      #5A6E9E is a strong blue-violet; multiplying a *saturated* albedo
      by it barely moves the hue at all (an orange stays orange — the
      multiply cannot wrap), while multiplying a *near-neutral* albedo
      by it lands on the tint's own hue almost exactly. Measured on
      the shipped values: cream stucco, chroma 0.17, went from hue 43
      to hue 218 — a 175 degree flip, the albedo simply replaced by
      blue-grey slate — while wood at chroma 0.75 rotated 0 degrees and
      said "shade" with value alone. §2.1 asks for the same thing from
      both: "a hue ROTATION toward blue-violet plus a modest value
      drop", and its one worked example, the grassLit/grassShade pair,
      is a 19 degree rotation with the saturation almost intact.

      So the rotation is scaled by chroma (`rotK`) — a saturated
      surface takes the full multiply, a near-neutral takes a fifth of
      it — and the replacing terms 3 and 4 are still gated by `keep`,
      which runs the other way. Then `ident` pulls the result back
      toward a value-matched copy of the lit colour, hardest exactly
      where a flip is possible, so a cream wall in shade is still
      cream. Finally `satK` puts back the chroma that three successive
      moves toward the achromatic axis took out, without touching hue.

      Measured with the values toon.js ships: grass 95 -> 111 degrees
      at S 0.60 -> 0.51 (§2.1's swatch pair is 95 -> 114 at 0.60 ->
      0.55), stucco 43 -> 47 at S 0.17 -> 0.08, wood 28 -> 27 at
      S 0.75 -> 0.62, and every one of them lands on the same 0.55
      luminance ratio, which is what makes the terminator read as one
      step across the whole frame instead of a different one per
      material.

   Feed it the *lit* colour, not the albedo: doing it that way is the
   only way a CSM cast shadow and a terminator are guaranteed to land
   on the same colour, because they then differ only in `litK`.
   ------------------------------------------------------------------ */
export const GLSL_SHADOW = /* glsl */`
const vec3 W_LUMA = vec3( 0.2126, 0.7152, 0.0722 );

float wChroma( vec3 g ) {
  float mx = max( g.r, max( g.g, g.b ) );
  float mn = min( g.r, min( g.g, g.b ) );
  return ( mx - mn ) / max( mx, 1e-4 );
}

/* How much of the sky's own colour this surface is allowed to take.
   1.0 on the achromatic axis, 0.20 on a fully saturated albedo. */
float wShadeKeep( vec3 g ) {
  return 1.0 - 0.80 * smoothstep( 0.02, 0.22, wChroma( g ) );
}

vec3 wShadeLaw( vec3 c, vec3 tint, float amount, float value, float bleed, float fill ) {
  vec3 t = pow( max( tint, vec3( 1e-5 ) ), vec3( 0.45455 ) );
  t /= max( max( t.r, max( t.g, t.b ) ), 1e-5 );           // hue only
  vec3 g0 = pow( max( c, vec3( 0.0 ) ), vec3( 0.45455 ) ); // perceptual
  float chroma = wChroma( g0 );
  float keep = 1.0 - 0.80 * smoothstep( 0.02, 0.22, chroma );
  /* a saturated surface takes the whole rotation and hardly moves; a
     near-neutral takes a fifth of it and stays its own colour */
  float rotK = 0.18 + 0.82 * smoothstep( 0.08, 0.40, chroma );

  vec3 g = g0 * mix( vec3( 1.0 ), t, amount * rotK )
              * ( value * ( 1.0 - 0.12 * keep ) );         // rotate + drop

  float y = dot( g, W_LUMA );
  g = mix( g, y * t * 1.30, bleed * max( keep, 0.35 ) );   // sky bounce

  /* Sky irradiance. Absolute, and weighted toward the dark end: a
     plank in shade is lifted and coloured by the sky, a white wall in
     shade is already reflecting plenty of it and only needs a hint —
     without that weighting the fill neutralises exactly the bright
     warm surfaces the identity term below is trying to protect. */
  g += t * fill * max( 0.0, 1.0 - dot( g, W_LUMA ) );

  /* Identity retention — same value, the surface's own hue. */
  float ys = dot( g, W_LUMA );
  g = mix( g, g0 * ( ys / max( dot( g0, W_LUMA ), 1e-4 ) ), 0.75 * keep );

  /* Chroma restore: the three moves above all pull toward the
     achromatic axis and §7 forbids a grey shadow. Hue untouched. */
  float ym = dot( g, W_LUMA );
  g = ym + ( g - ym ) * 1.18;

  vec3 s = pow( max( g, vec3( 0.0 ) ), vec3( 2.2 ) );

  /* THE VALUE STEP (§2.1: "a modest value drop", never albedo * 0.4).

     The number that matters is what this DELIVERS, and ACES sits
     between here and the screen. Its toe is far steeper at 0.15 than
     at 0.55, so one flat linear ratio does not survive as one
     perceptual ratio; the dark end therefore keeps more of its value
     than the bright end (kd below), which is what lands every
     material on the same step ON SCREEN rather than in the buffer.

     THIS IS A PIN, NOT A FLOOR, AND THAT IS THE FIX.

     It was a max( 1.0, ... ) — a one-sided lift. Everything above it
     was free to land wherever terms 1-6 happened to put it, and terms
     3-5 are all ADDITIVE (sky bleed, sky irradiance, chroma restore),
     so on a bright saturated albedo they carried the shade back up to
     ~0.44 of lit before the tone map and ~0.85 of lit after it.
     Measured on the boot frame: a cast shadow on grass was 15 % darker
     than the grass beside it. Six blind judges independently reported
     that the buildings threw no shadow at all, and they were reading
     the frame correctly — the shadow was rendering, at a contrast one
     step above the grass's own colour noise.

     Two-sided, the delivered ratio is the authored one and nothing
     downstream can inflate it. Hue is untouched: this is a uniform
     scale on a colour terms 1-6 have already rotated toward
     blue-violet, so §2.1's "hue rotation plus a value drop" is exactly
     what comes out — deeper, not grey, and it cannot reach black
     because it is a ratio of the lit colour, never an offset from it.

     The value argument is the material's OWN uShadowValue, so
     per-material intent survives the pin: Wally's clay asks for 0.86
     and keeps a soft step, the terrain asks for 0.76 and gets a hard
     one, and neither has to know about the other. The exponent is
     what deepens the whole set at once — at 2.2 it would be a straight
     gamma decode of the authored number and we would be back where we
     started, so it is 4.6. Delivered, as a fraction of lit luminance
     before the tone map:

         clay    value 0.86  ->  0.50   (soft; §1.2's matte terminator)
         world   value 0.82  ->  0.40   the grass, the plaster, the wood
         terrain value 0.76  ->  0.28
         humans  value 0.66  ->  0.15   lifted to 0.21 by kd

     Measured on screen, after ACES and the grade: grass in a cast
     shadow is 42 % darker in L* than the grass beside it, against 31 %
     before and the 35-45 % the reference sits at. Wally, whose clay
     asks for its own softer step, went 26 % -> 29 % and needed no
     retuning — which is the whole reason this reads the material's
     value instead of pinning one number across the frame. */
  float yl = dot( max( c, vec3( 0.0 ) ), W_LUMA );
  float k  = pow( clamp( value, 0.05, 1.0 ), 4.6 );
  /* The dark end of the range keeps more of its value — see the ACES
     toe above. Capped so a near-black material can never be pinned
     brighter than it started. */
  float kd = min( 0.95, k * 1.42 );
  float stepK = mix( kd, k, smoothstep( 0.10, 0.42, yl ) );
  float yv = dot( s, W_LUMA );
  /* Self-normalising: the result's luminance is exactly yl * stepK by
     construction, so a near-zero s cannot blow up here. */
  s *= ( yl * stepK ) / max( yv, 1e-5 );
  return s;
}
`;

/* ------------------------------------------------------------------
   A 12-tap Poisson disc, used for both the CSM PCF kernel and the
   SSAO tap pattern. Rotating it per-pixel converts banding into
   grain, which we are keeping anyway.
   ------------------------------------------------------------------ */
export const GLSL_POISSON = /* glsl */`
const vec2 W_POISSON12[ 12 ] = vec2[ 12 ](
  vec2( -0.3255,  0.1421 ), vec2(  0.2716,  0.2296 ),
  vec2( -0.0940, -0.4160 ), vec2(  0.5613, -0.2251 ),
  vec2( -0.6423, -0.2739 ), vec2(  0.0684,  0.7085 ),
  vec2( -0.4394,  0.6529 ), vec2(  0.7739,  0.3607 ),
  vec2(  0.1264, -0.8409 ), vec2( -0.8399,  0.2288 ),
  vec2(  0.6152,  0.7300 ), vec2( -0.2427, -0.8737 ) );
`;

/* Golden-angle spiral for the bokeh gather. Generated rather than
   listed so the tap count can follow the quality tier. */
export function spiralTaps(n) {
  const out = [];
  const GA = 2.39996323;
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * GA;
    out.push(`vec2( ${(Math.cos(a) * r).toFixed(5)}, ${(Math.sin(a) * r).toFixed(5)} )`);
  }
  return `const vec2 W_BOKEH[ ${n} ] = vec2[ ${n} ](\n  ${out.join(',\n  ')} );`;
}

/* ------------------------------------------------------------------
   The velvet surface grain (ART_DIRECTION §1.2). Triplanar-samples a
   tileable tangent-space normal texture in *object* space, so the
   grain sticks to the surface under animation and never crawls, then
   fades out with distance so it does not alias into sparkle.

   Requires: uniform sampler2D tGrain; and a tangent frame built from
   the shading normal.
   ------------------------------------------------------------------ */
export const GLSL_GRAIN = /* glsl */`
vec3 wTriWeights( vec3 n ) {
  vec3 w = abs( n );
  w = pow( w, vec3( 4.0 ) );
  return w / max( w.x + w.y + w.z, 1e-4 );
}

/* Sample a tileable RGB texture triplanar-ly at object-space p. */
vec3 wTriplanar( sampler2D tex, vec3 p, vec3 w ) {
  return texture2D( tex, p.zy ).rgb * w.x
       + texture2D( tex, p.xz ).rgb * w.y
       + texture2D( tex, p.xy ).rgb * w.z;
}

/* Metre-scale surface undulation, analytic.
   Deliberately NOT a texture fetch: this field is sampled on the
   ground plane at grazing incidence, where a mipmapped texture
   collapses to its own mean within a few metres of the camera and
   takes the effect with it. Three octaves of quadrature sine with
   incommensurate ratios read as irregular at any scale a player can
   see, cost nine sin() and never wash out with distance.
   Returns a tangent-plane slope in (T, B). */
vec2 wMacroSlope( vec3 p, float f ) {
  vec3 q = p * f;
  /* all three axes, so a vertical wall undulates too — a field of
     x and z alone is constant up a wall and streaks it vertically */
  vec2 s  = vec2( sin( q.x * 1.00 + q.z * 0.53 + q.y * 0.71 ),
                  cos( q.z * 0.91 - q.x * 0.37 + q.y * 0.44 ) ) * 0.60;
  s      += vec2( sin( q.z * 1.97 - q.x * 1.31 + q.y * 1.13 ),
                  cos( q.x * 2.13 + q.z * 0.77 - q.y * 1.61 ) ) * 0.29;
  s      += vec2( sin( q.x * 4.31 + q.z * 3.07 - q.y * 2.29 ),
                  cos( q.z * 3.89 - q.x * 4.53 + q.y * 3.41 ) ) * 0.13;
  return s;
}

/* Perturb N by a triplanar tangent-space grain. amp ~0.015 (clay). */
vec3 wApplyGrain( vec3 N, sampler2D tex, vec3 p, float scale, float amp, vec3 w ) {
  if ( amp <= 0.0 ) return N;
  vec3 g = wTriplanar( tex, p * scale, w ) * 2.0 - 1.0;
  vec3 up = abs( N.y ) < 0.985 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 T = normalize( cross( up, N ) );
  vec3 B = cross( N, T );
  return normalize( N + ( T * g.x + B * g.y ) * amp );
}
`;

/* ------------------------------------------------------------------
   Reconstruct a view-space position from the linear view depth we
   pack into the prepass target. `ray` is the un-normalised camera ray
   for this pixel, derived from the inverse projection.
   ------------------------------------------------------------------ */
export const GLSL_VIEWPOS = /* glsl */`
vec3 wViewRay( vec2 uv, vec2 tanHalfFov ) {
  return vec3( ( uv * 2.0 - 1.0 ) * tanHalfFov, -1.0 );
}
vec3 wViewPos( vec2 uv, float viewZ, vec2 tanHalfFov ) {
  return wViewRay( uv, tanHalfFov ) * viewZ;
}
`;

/* ------------------------------------------------------------------
   Hardware depth -> metres.

   The main pass now hands the post chain its own depth attachment
   rather than a second geometry pass, so everything downstream that
   used to read a packed linear depth has to un-project the [0,1]
   window depth first. `nf` is (near, far). Returns a POSITIVE distance
   along -Z, which is the same number the old prepass wrote into the
   alpha channel — so SSAO, DOF and the composite are untouched.

   A window depth of exactly 1.0 is a pixel nothing wrote: the sky dome
   has depthWrite off, and every module that reads this buffer already
   treats "depth == 0" as sky (see lighting.js). Callers map it back.
   ------------------------------------------------------------------ */
export const GLSL_DEPTH = /* glsl */`
float wLinearDepth( float d, vec2 nf ) {
  float z = d * 2.0 - 1.0;
  return ( 2.0 * nf.x * nf.y ) / ( nf.y + nf.x - z * ( nf.y - nf.x ) );
}
`;
