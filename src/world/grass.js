/* ============================================================
   grass.js — the blade field.

   ART_DIRECTION §2.3 lists grass first among the things that must
   visibly move, and Wind Waker spends half its charm on it. This is
   real bent geometry, not a texture and not a billboard: a five-vertex
   tapered blade, curved in its own local Z, instanced tens of
   thousands of times per chunk of island around the camera.

   FIVE THINGS MAKE IT READ
   1. It is lit as ground, not as a wall. The blade's normal is its
      own face normal blended 55 % toward +Y, and the material's
      back-face flip is spliced out (foliage.js/noBackflip) so a blade
      seen from behind is the same colour as one seen from in front.
      Without that, half of any field renders in the shade band and
      the meadow comes out striped.
   2. Its colour is the ground's colour. Every blade samples
      ctx.world.groundColorAt() through a per-chunk lattice and mixes
      toward the palette's grassLit, so grass agrees with the terrain
      it grows out of everywhere on the island — which is also what
      lets it fade into that terrain at distance instead of ending at
      a visible circle.
   3. It carries baked AO. The vertex-colour alpha darkens the blade
      toward its root (toon.js reads vColor.a as a warm occlusion
      term) and the per-instance tint darkens again near anything
      solid, so grass sits into walls and rocks instead of
      intersecting them.
   4. It bends: per-blade, quadratic in height, phased by world
      position so a gust crosses the field as a sheet.
   5. It gets out of the way — see the shader splice in foliage.js.

   FAR-FIELD COVERAGE IS BOUGHT WITH WIDTH, NOT HEIGHT. Rank is a
   static per-instance number, not a distance, so lifting the low
   ranks — the ones distance thinning keeps — also lifts low-rank
   blades standing a metre from the camera, and at 1.8x that broke the
   ankle law in the near field to fix a far-field problem. The lift is
   now small (1.35x, honest variation) and uFolFat carries the far
   field instead: it widens survivors with distance, in the shader,
   where it costs nothing and where it also kills the shimmer that
   sub-pixel geometry produces when the camera moves.

   SCALE IS ABSOLUTE, NOT TASTE. Wally is 1.7 m in world units, so a
   blade is 0.11-0.24 m and averages 0.16 — ankle height, never shin.
   Above that it stops reading as a lawn and starts reading as a
   scatter of green shards, which is exactly what it did at
   0.24-0.58 m. The blade is the unit of measurement for the whole
   meadow: halve it and the silhouette each blade contributes falls by
   ~4x (width scales with height), so density has to rise by the same
   factor again just to stand still. Hence BASE_DENSITY at 68 blades
   per m², not 9.5 — a carpet, in which a blade is only a blade in the
   nearest two or three metres.

   THE COST OF THAT IS PAID ON THE CPU, NOT THE GPU. Tens of thousands
   of blades a chunk are nothing to draw — one instanced call — but a
   lot to *place*, and the streamer builds a chunk inside a frame. So
   NO ground query runs per blade: clearance, the surface normal, the
   ground colour and the ground height are all sampled once per TUFT,
   and a blade takes its height off the tuft's tangent plane. The two
   instance buffers are written as raw floats and the bounding sphere
   is derived rather than measured. Together those are the difference
   between a 21 ms chunk and a 6 ms one at seven times the old grass.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { LAND, SEA, SKY } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';

/* Blade profile: three rows, tapering, curving forward in +Z — one
   quad and a tip triangle, five vertices, three triangles.

   IT USED TO BE FOUR ROWS AND FIVE TRIANGLES, and that was the right
   shape for a blade half a metre tall. At 0.18 m a blade is thirty
   pixels at the gameplay camera and under one at forty metres, and the
   third segment of its curve is not resolvable at either. Dropping it
   is 40 % of the field's triangles and 30 % of its vertices for a
   silhouette difference nobody can see — which is what paid for the
   density this file now runs at. */
const ROW_Y = [0.0, 0.55, 1.0];
const ROW_W = [0.098, 0.068, 0.0];
/* THE ARC IS THE TOP-DOWN SILHOUETTE. From a camera 30 m above a lawn
   you do not see a blade's height at all — you see the area it covers
   looking straight down, which is ROW_Z's forward lean, not ROW_Y. At
   0.46 a blade's plan footprint was ~0.08 x 0.03 m, so 95 blades/m²
   covered under a quarter of the ground from above and every town lawn
   averaged back to the bare terrain under it. Arcing further is free
   (same vertices, same triangles), reads as grass laid over rather
   than standing to attention, and is the only lever here that raises
   overhead coverage without raising instance count. */
const ROW_Z = [0.0, 0.14, 0.58];
/* THE ROOT AO IS NOT A SHADOW, IT IS A BED. At 0.40 the root band
   compounded with the root colour row, the contact tint and the near
   depth grade, and the four together put the bottom of every blade
   near black — which measured, on the boot frame, as a p05-p20 of
   V 42 against §2.1's shaded grass at V 60, and read as a scatter of
   dirty speckles across the whole lower half rather than as grass.
   The bed still exists; it is one stop deep instead of three. */
const ROW_AO = [0.62, 0.86, 1.0];
/* THE ROOT-TO-TIP RAMP IS A HUE RAMP, NOT A BRIGHTNESS ONE.

   The tip is what an elevated camera sees — nearly all of it — so it
   has to carry a real gradient or a lawn dissolves into the terrain
   under it. But this used to be three GREY multipliers topping out at
   1.45, and 1.45x a saturated green is the single biggest reason two
   independent reviews called this field "acid" and "nuclear": the
   albedo the eye actually sampled was half again brighter than
   §2.1's #7EC24E, and ACES rolls an over-bright saturated green
   toward yellow, which is where the measured hue 86 (against the
   swatch's 95) came from.

   Same 1.73:1 top-to-bottom ratio — the gradient was never the
   problem — but 17 % less luminance at the tip, and each row is now
   an RGB triple rather than a scalar so it carries §2.1's law up the
   blade: the shaded root shifts toward blue-green, the sunlit tip
   stays green rather than going yellow (red held BELOW green, which
   is what pulls the measured hue back up toward the swatch).

   AND THE RAMP HAS A FLOOR. #4E9A46 is the DARKEST green §2.1 allows
   the field to reach, and the root row at 0.58 was heading well below
   it before AO, contact and the depth grade had had their turn:
   measured on the boot frame the darkest fifth of the lower half sat
   at V 42 H 141 — a near-black teal, i.e. the speckling. The ratio
   across the blade is 1.46:1 now rather than 1.73:1, which is still a
   real gradient and still the right direction; it simply starts at
   the shade swatch instead of below it. */
const ROW_COL = [
  [0.76, 0.83, 0.81],   // root — darker, cooler, blue-green (§2.1)
  [0.94, 1.02, 0.96],
  [1.10, 1.21, 0.99],   // tip  — brightest, still green, never yellow
];

function bladeGeometry() {
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const n = ROW_Y.length;

  for (let r = 0; r < n; r++) {
    const rp = Math.min(r + 1, n - 1), rm = Math.max(r - 1, 0);
    const dy = ROW_Y[rp] - ROW_Y[rm] || 1;
    const dz = ROW_Z[rp] - ROW_Z[rm];
    let ny = dz, nz = -dy;
    const l = Math.hypot(ny, nz) || 1;
    ny = lerp(ny / l, 1, 0.55);
    nz = lerp(nz / l, 0, 0.55);
    const l2 = Math.hypot(ny, nz) || 1;

    const w = ROW_W[r];
    for (const x of (w > 0 ? [-w, w] : [0])) {
      pos.push(x, ROW_Y[r], ROW_Z[r]);
      nor.push(0, ny / l2, nz / l2);
      uv.push(x / (ROW_W[0] * 2) + 0.5, ROW_Y[r]);
      const k = ROW_COL[r];
      col.push(k[0], k[1], k[2], ROW_AO[r]);
    }
  }
  for (let r = 0; r < n - 2; r++) {
    const a = r * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const t = (n - 2) * 2;
  idx.push(t, t + 1, t + 2);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function createGrassLayer(ctx, env) {
  const { CHUNK, GRASS_DIST, DENS, world: W } = env;

  /* THE NEAR-FIELD TINT IS §2.1's SHADOW LAW, NOT A COLOUR I PICKED.
     It is the component-wise ratio #4E9A46 / #7EC24E — i.e. exactly
     the multiply that turns the palette's lit grass into the palette's
     shaded grass — walked a third of the way back toward white so it
     lands between the two swatches rather than on the darker one.
     Because blue is the least attenuated channel of that ratio, it
     rotates hue toward blue-green on the way down, which is what §2.1
     says shade must do and never toward black. */
  const NEAR_TINT = (() => {
    const a = env.lin(LAND.grassLit), b = env.lin(LAND.grassShade);
    const r = [b.r / a.r, b.g / a.g, b.b / a.b];
    /* The raw ratio rotates hue hard — measured, it took the near
       field to saturation 72 against a palette whose two grass
       swatches are 55 and 60, i.e. it traded one wrong green for
       another. Pulled 46 % toward its own luminance so it still
       shifts toward blue-green, just not past the high-key set. */
    const y = 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2];
    /* AMPLITUDE, NOT DIRECTION. At t 0.33 this landed a 0.71 linear
       multiplier on every blade inside 30 m — thirteen sRGB value
       points off the near field, on top of the terrain sheet's own
       near grade, on top of a root ramp that already started below
       the shade swatch. Three grades stacked on the same pixels is
       how the lower half of the frame came out at V 58 against a
       #7EC24E that measures V 76. 0.62 is 0.84 linear, ~7 points:
       still a readable near-to-far ramp, no longer the dominant
       exposure decision in the shot. The luminance pull is 0.62 for
       the same reason — the raw ratio rotated the near field to hue
       138 against the shade swatch's 114. */
    /* 0.56. Six points deeper than the last pass, and no more than
       that: the near grade is the only value ramp the bottom third of
       a gameplay frame gets, fog does not reach it and the turf pale
       is barely a quarter in at thirty metres — but three grades
       stacked on the same pixels is how this field previously
       measured V 58 against a #7EC24E that measures V 76. Moved in
       lockstep with terrain.js's uGndNear so the sheet and the blades
       stay one surface. */
    const t = 0.56;
    return new THREE.Color(
      ...r.map((v) => lerp(lerp(v, y, 0.62), 1, t)));
  })();

  /* ------------------------------------------------------------
     Material. White albedo — the colour arrives per instance, so a
     single material paints the whole island's worth of local greens
     and the whole field is one draw call per chunk.
     ------------------------------------------------------------ */
  const mat = ctx.mat.foliage({
    name: 'foliage.grass',
    color: 0xffffff,
    map: false,                 // real geometry, no alpha cards
    alphaTest: 0,
    side: THREE.DoubleSide,
    vertexColors: true,
    sssColor: LAND.grassLit,
    sss: 0.16,
    /* NO RIM ON GRASS, AND ALMOST NO SKY BOUNCE. Both are fresnel
       terms, and a blade of grass under a low camera is edge-on
       everywhere, so both fire at full strength over the whole field
       — measured, the default warm rim (#FFE6BC at 0.5) turned every
       blade into a cream straw and the meadow read as hay. The rim
       exists to separate an object from its background; grass IS the
       background. */
    rim: 0,
    skyBounce: 0.05,
    term: 0.11,
    band2: 0.24,
    core: 0.50,
    grain: 0.008,
    grainScale: 7.0,
    grainAlbedo: 0.07,
    /* a small shared sway under the per-blade bend, so a blade sitting
       at a node of the wave wave still has life in it */
    wind: 0.12,
    windBase: 0,
    windHeight: 1,
    outline: false,
    noOutline: true,
  });
  env.noBackflip(mat);

  /* THE FALLOFF IS THE WHOLE SUBSYSTEM. Get it wrong and none of the
     rest of this file matters, because the eye does not read grass by
     counting blades — it reads the EDGE where the blades stop. At
     GRASS_DIST 110 the old d1 of 0.20 held full density to 22 m and
     hit its floor at 55 m, which drew a hard horizontal line straight
     across the frame at the exact depth the mid-ground begins: dense
     meadow below it, a bare terrain sheet above it, every building and
     tree in the shot standing on the bare half. There is no amount of
     near-field craft that survives that line.

     So: full density all the way out to 50 m — past everything the
     gameplay camera reads as "the field" — a long 44 m ramp after it,
     and a floor high enough (0.28, ~19 blades/m²) that the far band is
     still grained rather than clean. The fade must dissolve INTO the
     terrain, never terminate against it. Distance here is also 3-D:
     a camera 32 m above Main Street is 32 m from the lawn it is looking
     straight down at, which is what flatY below is for. */
  /* FULL DENSITY IS AN ABSOLUTE RADIUS, NOT A FRACTION OF THE RING.

     It used to be GRASS_DIST * 0.45, and that coupling is a trap: the
     only cheap lever a quality tier has is the ring, and every metre
     it takes off the ring also took 45 cm off the full-density radius
     — so lowering a tier thinned the grass around the player's feet,
     which is the one place the field is read as a field. Shipped, at
     the 'high' tier, that was a carpet with visible ground between
     the blades in the front third of the frame: the exact "acid
     shards" two blind reviews rejected.

     46 m is past everything a 2 m gameplay camera reads as "the
     field", so the near band is now identical at high and at ultra
     and the tiers differ only in how far the tail runs. The floor is
     0.18 rather than 0.28 and uFolFat carries the difference: far
     coverage is bought with width, which is free, not with instances,
     which are not. */
  const LOD = new THREE.Vector4(
    Math.min(GRASS_DIST * 0.64, 46), GRASS_DIST * 0.86, GRASS_DIST, 0.18);
  const folU = env.folUniforms({
    d1: LOD.x, d2: LOD.y, d3: LOD.z, frac: LOD.w,
    /* PUSH PARTS THE GRASS, IT DOES NOT MOW IT. At 1.05 against a
       0.18 m blade the sink term buried the tip 0.095 m — over half
       the blade — and flung it 0.19 m sideways, so Wally stood in a
       bald crop-circle of flattened green with nothing touching his
       feet. The one place the eye is guaranteed to look was the one
       place with no grass. 0.42 bends; it does not flatten. */
    bend: 0.60, push: 0.42,
    /* 3.2x wide at the far end — see FOL_BODY. Coverage past the ramp
       is bought with width, not with height and not with instances:
       a blade at 60 m is a sub-pixel needle and widening it is both
       cheaper than more of them and the only thing that kills the
       shimmer. This is what pays for the far-field density the height
       lift used to fake. */
    fat: 2.9,
    /* An elevated camera is not far from the ground under it — see
       FOL_BODY. Free at the gameplay camera's two metres; what it buys
       is density under the city fly-to and on the hillsides below a
       clifftop, which the raw 3-D distance was fading out. */
    flatY: 0.7,
    /* THE DEPTH GRADE (see FOL_BODY in foliage.js). Measured on the
       review frame, this field ran V 78 % at the bottom edge of the
       canvas and V 78 % at the treeline — no range at all, which is
       what "a dead, unmodulated slab" means. fog cannot supply it:
       §2.4's haze starts around 100 m and the blades stop at 110.

       near : 30 m. Grass at your boots is the darkest, most saturated
              green in the frame — it is in its own shadow and there is
              no air between it and the lens.
       far  : 14 -> 95 m, 0.62. The far end pales toward §2.4's
              #B8DEF0 but only two thirds of the way, so the last band
              of blades still has hue in it and hands over to the
              terrain's own fog rather than ending on a white line.

       THE TWO RAMPS MUST OVERLAP. First cut ran 0-24 and 26-104, and
       smoothstep is flat at both of its ends: measured, the 25-50 m
       band came out with a fog factor of 0.04 and no near grade at
       all — a dead zone straight across the middle of the frame,
       which is precisely the depth the eye reads as "the field".
       Starting the pale at 14 puts its steep section under the near
       grade's tail so the two hand over continuously. */
    air: [34, 14, 95, 0.78],
    airNear: NEAR_TINT,
    airFar: env.mixHex(LAND.grassLit, SKY.haze, 0.44),
  });
  env.patch(mat, folU);

  /* Live LOD tuning. The falloff is the one number in this file that
     has to be judged against a frame rather than reasoned about, and
     it has to be judged against the frame TIME too — so it is driveable
     from a screenshot session. The CPU vector and the shader uniform
     move together, because a mesh.count lower than the shader's cutoff
     makes instances appear at full size instead of scaling in, which is
     pop-in. */
  function setLOD(d1, d2, frac, fat) {
    LOD.set(d1, d2, LOD.z, frac);
    folU.uFolLOD.value.set(d1, d2, LOD.z, frac);
    if (fat != null) folU.uFolFat.value = fat;
    return { d1, d2, d3: LOD.z, frac, fat: folU.uFolFat.value };
  }

  const BLADE = bladeGeometry();

  /* ------------------------------------------------------------
     Chunk build.

     turf() costs a handful of heightfield taps and groundColorAt()
     costs four fBm octaves, so neither is evaluated per blade —
     both are rasterised to a small per-chunk lattice and read back
     bilinearly. That is the difference between a 0.4 ms chunk and a
     4 ms one, i.e. between streaming and stuttering.
     ------------------------------------------------------------ */
  /* 52/m² at density 1, so ~73/m² on the ultra tier's 1.4 and ~29/m²
     on med's 0.55. Measured at 1600x900: the field costs ~3 M
     triangles and ~55 fps of headroom at this number and nearly twice
     that at 62, which was over the 60 fps floor on the ultra tier. */
  const BASE_DENSITY = 68;               // blades per m² at density 1
  const TSTEP = 2;                       // turf lattice pitch, metres
  const TN = Math.round(CHUNK / TSTEP) + 1;
  const CN = 7;                          // ground-colour lattice
  const CSTEP = CHUNK / (CN - 1);
  const QN = 13;                         // tone lattice, 1.7 m pitch
  const QSTEP = CHUNK / (QN - 1);
  const QC = 5;                          // channels on the tone lattice

  const _c = new THREE.Color();
  const _key = new THREE.Color();
  /* The Matrix4/Quaternion/Vector3 scratch this file used to keep for
     the blade loop is gone with the loop: the instance matrix is
     written as sixteen floats from a 3x3 the tuft already carries. */
  const _nrm = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const GRASS_LIT = env.lin(LAND.grassLit);
  const GRASS_SHADE = env.lin(LAND.grassShade);

  /* ------------------------------------------------------------
     FOUR KINDS OF GRASS, ALL DERIVED FROM §2.1's PAIR.

     "A lawn is never one colour" — and this field was one colour with
     a per-blade wobble on it, which averages straight back to one
     colour the moment a blade falls under a pixel. Per-blade variance
     is not variation; variation is the half-hectare patch that reads
     as a different KIND of ground from the half-hectare beside it.

     None of these four is invented. Each is #7EC24E or #4E9A46 walked
     toward another swatch already in the palette, which is what keeps
     the whole field inside one high-key set instead of turning into a
     patchwork of four unrelated greens.
     ------------------------------------------------------------ */
  /* MEASURE THE MIX, NOT THE INGREDIENT. A lerp toward a bright
     turquoise in LINEAR space rotates hue about three times as far as
     the mix weight suggests: at 0.13 toward SEA.shallow this swatch
     measured hue 139 — twenty-five degrees past §2.1's shaded grass —
     and mRough then drove whole patches of the field onto it at 0.92.
     That teal, not the value drop, is what the near-black speckling
     across the lower half actually was. 0.035 lands the swatch at hue
     ~121, i.e. between the two grass entries where a fourth green
     belongs, and the weight below is halved so a rough patch is a
     rough patch rather than a repaint. */
  const G_MOWN = GRASS_LIT.clone().lerp(GRASS_SHADE, 0.16);            // kept lawn
  const G_ROUGH = GRASS_SHADE.clone().lerp(env.lin(SEA.shallow), 0.035); // unmown, cool
  const G_DRY = GRASS_LIT.clone().lerp(env.lin(LAND.sand), 0.36);      // sun-bleached
  const G_WORN = GRASS_SHADE.clone().lerp(env.lin(LAND.dirt), 0.46);   // trodden, earth through

  const turfLat = new Float32Array(TN * TN);
  const colLat = new Float32Array(CN * CN * 3);
  /* The four character fields, on their own finer lattice. */
  const toneLat = new Float32Array(QN * QN * QC);

  /* PER-TUFT SCRATCH, NOT PER-BLADE.

     The build used to place every blade into an 11-float scratch row,
     Fisher-Yates the whole array, then walk it again to compose a
     Matrix4 per blade. Measured at 32 400 blades a chunk that was
     1.4 ms of shuffle and 4.6 ms of Matrix4 round-trip on top of
     2.6 ms of actual placement — 8.4 ms for one 20 m chunk, which the
     streamer then ran six of in a single frame.

     Now the tuft pass writes THIS, once per tuft, and the blade pass
     composes straight into the instanceMatrix in rank order. There is
     no shuffle and no intermediate per-blade array at all.

       0,1     cx, cz            tuft centre
       2       y0                ground height at the centre
       3,4     gx, gz            tangent-plane gradient
       5..13   r0..r8            the tuft's tilt basis, column-major
       14,15,16 r, g, b          colour, AO already folded in
       17      spread            tuft radius
       18      per               blades in this tuft  */
  const TSTRIDE = 20;
  let tcap = 0, T = null;
  function growTufts(n) {
    if (n <= tcap) return;
    tcap = Math.ceil(n * 1.25);
    T = new Float32Array(tcap * TSTRIDE);
  }

  function turfLerp(u, v) {
    const fx = clamp(u / TSTEP, 0, TN - 1.001), fz = clamp(v / TSTEP, 0, TN - 1.001);
    const i = fx | 0, j = fz | 0, ax = fx - i, az = fz - j;
    const a = lerp(turfLat[j * TN + i], turfLat[j * TN + i + 1], ax);
    const b = lerp(turfLat[(j + 1) * TN + i], turfLat[(j + 1) * TN + i + 1], ax);
    return lerp(a, b, az);
  }
  function colLerp(u, v, out) {
    const fx = clamp(u / CSTEP, 0, CN - 1.001), fz = clamp(v / CSTEP, 0, CN - 1.001);
    const i = fx | 0, j = fz | 0, ax = fx - i, az = fz - j;
    const a = (j * CN + i) * 3, b = a + 3;
    const c = ((j + 1) * CN + i) * 3, d = c + 3;
    out.setRGB(
      lerp(lerp(colLat[a], colLat[b], ax), lerp(colLat[c], colLat[d], ax), az),
      lerp(lerp(colLat[a + 1], colLat[b + 1], ax), lerp(colLat[c + 1], colLat[d + 1], ax), az),
      lerp(lerp(colLat[a + 2], colLat[b + 2], ax), lerp(colLat[c + 2], colLat[d + 2], ax), az));
    return out;
  }
  /* Same bilinear read, on the tone lattice. out is [rough, worn, dry, swell].

     ITS OWN LATTICE, FINER THAN THE COLOUR ONE. The ground colour
     costs four fBm octaves plus a wideSteep and a lipFactor per tap,
     so its lattice has to stay at 3.3 m; these are two octaves of
     value noise and cost nothing, and at 3.3 m the 8 m patch field
     was sampled barely twice a period and came back as mush. */
  const _tone = [0, 0, 0, 0, 0];
  /* fBm sits in a narrow band about its mean; stretch about the centre
     before thresholding or every patch mask reads as its own average. */
  const bandSpread = (v, k) => clamp((v - 0.5) * k + 0.5, 0, 1);
  function toneLerp(u, v) {
    const fx = clamp(u / QSTEP, 0, QN - 1.001), fz = clamp(v / QSTEP, 0, QN - 1.001);
    const i = fx | 0, j = fz | 0, ax = fx - i, az = fz - j;
    const a = (j * QN + i) * QC, b = a + QC;
    const c = ((j + 1) * QN + i) * QC, d = c + QC;
    for (let k = 0; k < QC; k++) {
      _tone[k] = lerp(lerp(toneLat[a + k], toneLat[b + k], ax),
                      lerp(toneLat[c + k], toneLat[d + k], ax), az);
    }
    return _tone;
  }

  /* ------------------------------------------------------------
     RANK ORDER IS ROW-MAJOR OVER TUFTS — and that is the whole
     optimisation.

     Blade j of tuft k lands at instance index (blades in rows before
     j) + k. So the first `tufts` instances are ONE blade from every
     tuft in the chunk, the next `tufts` are a second blade from every
     tuft, and so on. Three consequences:

       - A PREFIX of the instance list is a uniform thinning of the
         whole chunk — every tuft loses the same fraction — which is
         exactly what the Fisher-Yates shuffle this replaces was for,
         except that it costs nothing to produce. (Tufts are placed at
         uniform random u,v, so their INDEX order is already a random
         spatial order; stopping part-way through a row is uniform
         too.)
       - It is STABLE. The first n instances are the same blades in
         the same places whatever n is, so a chunk rebuilt at a nearer
         band is a strict superset of the one it replaces and not one
         blade moves.
       - Therefore a chunk that can never be seen above 28 % density
         only has to RUN the first 28 % of the rows. Which is the
         point: at a 110 m radius, four fifths of the chunks in the
         ring are past the LOD's full-density distance and were being
         built at full density anyway, then thrown away by mesh.count.
     ------------------------------------------------------------ */

  /* Build bands, keyed on the NEAREST distance a chunk in the band
     can sit at, so a band's build is always at least what the shader
     will ask for anywhere inside it. Band 0 is full density; band 4
     is everything past the LOD ramp, which is flat at its floor. */
  const NBANDS = 5;
  function bandNear(b) {
    if (b <= 0) return 0;
    if (b >= NBANDS - 1) return LOD.y;
    return LOD.x + (b - 1) * (LOD.y - LOD.x) / (NBANDS - 2);
  }
  function bandFor(d) {
    if (d < LOD.x) return 0;
    if (d >= LOD.y) return NBANDS - 1;
    return 1 + Math.min(NBANDS - 3, Math.floor((d - LOD.x) / ((LOD.y - LOD.x) / (NBANDS - 2))));
  }

  /* A blade's own random stream, seeded from (chunk, tuft, row).
     Sequential draws off one generator would make a blade depend on
     how many blades ran before it, and the entire point of a band
     build is that it can stop early and still produce bit-identical
     blades. Shared mutable state rather than a closure per blade:
     thirty thousand closures a chunk is its own performance bug. */
  let _S = 0;
  function R32() {
    _S = (_S + 0x6d2b79f5) | 0;
    let t = Math.imul(_S ^ (_S >>> 15), 1 | _S);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }
  /* A blade needs five independent randoms and a mulberry32 step is
     about ten integer ops, so five steps is fifty ops before any of
     the actual maths. One 32-bit word carries three eleven-bit fields
     with room to spare, and eleven bits is 0.05 % of a blade's jitter
     range — two draws instead of five. */
  const B11 = 1 / 2048, B8 = 1 / 256;

  /* YAW FROM A TABLE. Math.sin and Math.cos are the two most
     expensive things in the blade loop by a wide margin, and a blade
     rotated to the nearest 0.7 degree is a blade rotated randomly.
     512 entries, built once. */
  const YAWN = 512;
  const YAWC = new Float32Array(YAWN), YAWS = new Float32Array(YAWN);
  for (let i = 0; i < YAWN; i++) {
    const a = (i / YAWN) * Math.PI * 2;
    YAWC[i] = Math.cos(a); YAWS[i] = Math.sin(a);
  }

  function build(ci, cj, band = 0) {
    const ox = ci * CHUNK, oz = cj * CHUNK;

    /* Cheap reject: a chunk entirely at sea, on cliff or under tarmac. */
    let any = 0;
    for (let k = 0; k < 9 && any <= 0.05; k++) {
      any += env.turf(ox + (k % 3) * CHUNK * 0.5, oz + (((k / 3) | 0) * CHUNK * 0.5));
    }
    if (any <= 0.05) return null;

    for (let j = 0; j < TN; j++) {
      for (let i = 0; i < TN; i++) turfLat[j * TN + i] = env.turf(ox + i * TSTEP, oz + j * TSTEP);
    }
    for (let j = 0; j < CN; j++) {
      for (let i = 0; i < CN; i++) {
        const wx = ox + i * CSTEP, wz = oz + j * CSTEP;
        env.groundColorAt(wx, wz, _c);
        const o = (j * CN + i) * 3;
        colLat[o] = _c.r; colLat[o + 1] = _c.g; colLat[o + 2] = _c.b;
      }
    }
    /* FIVE SCALES, ALL LARGER THAN A BLADE AND ALL SMALLER THAN THE
       SHOT. The first attempt put these at 55 / 30 / 13 m, and a
       gameplay camera sees about sixty metres of field — so the whole
       lower half of the frame sat inside ONE patch of each and the
       field rendered exactly as flat as it had before. Variation you
       cannot fit two of into the frame is not variation.

       AND 33 m WAS STILL TOO BIG. Two more blind rounds later the
       verdict has not moved — "one uniform high-saturation hue with no
       value range" — and the reason is arithmetic: a 33 m field fits
       under two periods into sixty metres of visible ground, so it
       delivers a gradient rather than patches, and a gradient across
       a whole frame is indistinguishable from a flat fill. Every
       scale here is now one the eye can find two or three of between
       Wally's feet and the buildings.
         24 m  mown lawn vs rough unmown ground
         15 m  how sun-bleached this meadow is
        8.7 m  trodden patches, earth coming through
         21 m  a plain luminance swell under all of it, which is what
               stops the boundaries between the other three from being
               the only thing the eye can find
        9.5 m  and a second swell inside the first, because one swell
               at one scale is a wobble and two beating against each
               other is ground. */
    for (let j = 0; j < QN; j++) {
      for (let i = 0; i < QN; i++) {
        const wx = ox + i * QSTEP, wz = oz + j * QSTEP;
        const o = (j * QN + i) * QC;
        toneLat[o] = env.noise.fbm(wx * 0.042 + 61.3, wz * 0.042 - 17.9, 2);
        toneLat[o + 1] = env.noise.fbm(wx * 0.115 - 8.1, wz * 0.115 + 33.4, 2);
        toneLat[o + 2] = env.noise.fbm(wx * 0.068 + 121.7, wz * 0.068 - 74.2, 2);
        toneLat[o + 3] = env.noise.fbm(wx * 0.048 - 55.4, wz * 0.048 + 12.6, 2);
        toneLat[o + 4] = env.noise.n2(wx * 0.105 + 9.7, wz * 0.105 - 88.3);
      }
    }

    const want = Math.round(CHUNK * CHUNK * BASE_DENSITY * DENS.value);
    if (want < 16) return null;
    const seed = (0x51a3 ^ (ci * 73856093) ^ (cj * 19349663)) >>> 0;
    const rng = ctx.makeRng(seed);

    /* ------------------------------------------------------------
       PASS 1 — TUFTS.

       TUFTS, NOT A SPRINKLE. Blades placed by uniform random over the
       chunk read as a thin scatter of individual straws no matter how
       many you spend, because nothing ever overlaps enough to make a
       mass. Wind Waker grass is clumps with bare ground between them,
       and clumping the same instance count into tufts of seven to
       twelve inside a 20 cm radius is free: it costs nothing extra,
       it is what makes the field read as a mass rather than a
       sprinkle, and it is what lets every ground query be answered
       once for ten blades instead of once each.

       This pass is band-INDEPENDENT on purpose. The tuft lattice is
       the field's structure; thinning it with distance would swap one
       structure for another every time a chunk crossed a band, and
       that is a visible twinkle across the whole far field whenever
       you walk. Only the number of blades PER tuft varies with band,
       which is a density change and nothing else.
       ------------------------------------------------------------ */
    const PER_TUFT = 9.5;                 // mean blades per tuft
    const tuftsWant = Math.max(1, Math.round(want / PER_TUFT));
    growTufts(tuftsWant);

    let nt = 0, nom = 0, maxPer = 0;
    let ylo = Infinity, yhi = -Infinity;

    for (let k = 0; k < tuftsWant; k++) {
      const cu = rng() * CHUNK, cv = rng() * CHUNK;
      const t = turfLerp(cu, cv);
      if (t < 0.06 || rng() > t) continue;

      const per = 7 + ((rng() * 6) | 0);
      const spread = 0.08 + rng() * 0.16;
      const cx = ox + cu, cz = oz + cv;

      /* ONE clearance / normal / colour query for the whole tuft.
         The margin keeps a tuft whose blades straddle a wall from
         growing through it — 0.24 m of setback nobody will ever see. */
      const cl = env.clearance(cx, cz);
      if (cl < 0.35 + spread) continue;
      /* CONTACT. Grass does not meet a wall at full brightness — the
         wall occludes half its sky and the turf under it is in
         permanent shade. At 0.66..1.0 over five metres this was a 13 %
         drop, which is inside the field's own noise, and it is most of
         why every house in the review frame read as "floating on a
         flat cutout". 0.44..1.0 over six and a half metres is a real
         bed. It also runs the same direction as the ground-contact AO
         the lighting pass is adding, so the two compound instead of
         one washing the other out. */
      const ao = 0.44 + 0.56 * smoothstep(0.30, 6.5, cl);

      W.normalAt(cx, cz, _nrm);
      /* THE TUFT'S TILT BASIS, BUILT DIRECTLY — no quaternion, no
         slerp. Grass grows up, not perpendicular to the hill, so the
         blade's own up is the ground normal mixed 0.45 of the way
         from vertical; Rodrigues from +Y to that vector is twenty
         flops, where setFromUnitVectors + Quaternion.slerp +
         quaternion-to-matrix was an acos, two sins and three object
         round-trips per tuft. */
      let mx = _nrm.x * 0.45, my = 1 + (_nrm.y - 1) * 0.45, mz = _nrm.z * 0.45;
      const ml = 1 / Math.sqrt(mx * mx + my * my + mz * mz);
      mx *= ml; my *= ml; mz *= ml;
      const vx = mz, vz = -mx, kk = 1 / (1 + my);
      /* columns of R, the rotation taking +Y to (mx,my,mz) */
      const r0 = 1 - kk * vz * vz, r1 = vz,                          r2 = kk * vx * vz;
      const r3 = -vz,              r4 = 1 - kk * (vx * vx + vz * vz), r5 = vx;
      const r6 = kk * vx * vz,     r7 = -vx,                         r8 = 1 - kk * vx * vx;

      /* The tuft's tangent plane, so a blade's ground height is two
         multiplies rather than a heightfield tap. Over a 24 cm tuft the
         plane and the field agree to under a millimetre, and the tap
         was a fifth of the whole chunk build at this density. */
      const y0 = W.heightAt(cx, cz);
      const gx = -_nrm.x / _nrm.y, gz = -_nrm.z / _nrm.y;

      /* MOTTLE AT TUFT SCALE, NOT BLADE SCALE. Per-blade tone variance
         averages back to a flat green the moment a blade is smaller
         than a pixel, which is every overhead shot of the city. Tone
         that varies across half-metre clumps survives that averaging
         and is what makes a lawn read as a lawn from a rooftop. */
      /* AND IT MUST NOT MATCH THE GROUND IT GROWS OUT OF. Sampling the
         terrain colour is what lets the field dissolve at its far edge,
         but mixed only 0.24 toward grassLit the blade WAS the terrain,
         so the moment a blade fell under a pixel the whole lawn averaged
         back to the same flat green as the bare ground beside it and
         every town lawn seen from a rooftop read as painted turf. So
         the tuft keeps 40 % of its local ground drift and takes the
         rest from a key of its own — but that key is now four greens
         chosen by patch, not one, because "its own brighter, yellower
         key" is precisely the acid the reviews measured. */
      /* PATCHES, NOT A GRADIENT — terrain.js states the same law and
         for the same reason: lerping continuously between two greens
         by an fBm is an AVERAGE, so everything lands on the mean tone
         and the whole field renders as one flat mint. Threshold each
         field into a patch mask first, then mix. */
      /* STRETCH BEFORE YOU THRESHOLD. 2-octave fBm lives in about
         0.3-0.7, so a threshold at 0.84 never fires and a "patch mask"
         that never fires is a field that renders as one green — which
         is exactly what the first attempt at this shipped. Same
         spreadN() the heightfield's own colour uses, same reason. */
      const tn = toneLerp(clamp(cu, 0, CHUNK), clamp(cv, 0, CHUNK));
      const mRough = smoothstep(0.56, 0.20, bandSpread(tn[0], 2.5));
      const mWorn = smoothstep(0.58, 0.90, bandSpread(tn[1], 2.6));
      const mDry = smoothstep(0.50, 0.86, bandSpread(tn[2], 2.4));

      colLerp(clamp(cu, 0, CHUNK), clamp(cv, 0, CHUNK), _c);
      /* The key this tuft is heading for. Not GRASS_LIT — that swatch
         is the BRIGHTEST value the field is allowed to reach, and
         driving every blade at it is how a lawn ends up with its mean
         sitting on its own maximum. */
      _key.copy(G_MOWN)
        .lerp(G_ROUGH, mRough * 0.58)
        .lerp(G_DRY, mDry * 0.72)
        .lerp(G_WORN, mWorn * 0.52);
      /* 0.52, NOT 0.60 — the blade now inherits HALF its colour from
         the sheet it grows out of. terrain.js's turf mosaic runs at
         26 m and 11 m and carries the road verges and the yards; if
         the blades keep only 40 % of it, the field's structure and
         the ground's structure are two uncorrelated noises that
         average each other back to flat, which is what was shipping.
         Correlated, the patch reads as a patch of GROUND — grass and
         soil agreeing is what makes a meadow look like a place. */
      _c.lerp(_key, 0.52);
      /* VALUE GOES WITH THE CHARACTER, NOT ONLY HUE. Four greens at
         the same brightness is still one value, and value is what the
         reviews measured. Rough ground is darker because it is deeper
         and shades itself; worn ground is darker still; a bleached
         patch is the only thing in the field allowed above 1. Spread
         SYMMETRICALLY about 1, so the dry patches climb as far as the
         worn ones fall and the field's mean does not move. */
      const patchK = 1 - 0.15 * mRough + 0.17 * mDry - 0.21 * mWorn;
      /* ...plus a plain swell under all of it, so the field has tone
         even where none of the three characters is doing anything.
         TWO scales beating against each other: a single swell at a
         single period is a wobble, and the eye reads a wobble as
         noise on a flat fill rather than as ground. */
      const swellK = (0.78 + 0.44 * bandSpread(tn[3], 2.3))
                   * (0.92 + 0.17 * bandSpread(tn[4], 2.0));
      /* Slope reads darker: a hillside turns away from the key and
         holds more litter and moss than a level lawn does. */
      const slopeK = 1 - 0.24 * smoothstep(0.05, 0.34, 1 - _nrm.y);
      /* Per-tuft scatter, and the AO folded in with it — the blade
         pass then costs one multiply instead of two. */
      _c.multiplyScalar((0.91 + rng() * 0.17) * patchK * swellK * slopeK
                        * (0.50 + 0.50 * ao));
      /* ONE CHROMA PULL, LAST. Every mix above heads toward a
         saturated swatch and the toon pass then adds a green SSS
         bleed at the terminator on top of that, so the rendered field
         measured saturation 75 against a palette whose two grass
         swatches are 55 and 60. §2.1 is a high-key set, not a poison
         one, and "acid" is as much a saturation word as a value one. */
      const yl = 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b;

      const o = nt * TSTRIDE;
      T[o] = cx; T[o + 1] = cz; T[o + 2] = y0 - 0.016;
      T[o + 3] = gx; T[o + 4] = gz;
      T[o + 5] = r0; T[o + 6] = r1; T[o + 7] = r2;
      T[o + 8] = r3; T[o + 9] = r4; T[o + 10] = r5;
      T[o + 11] = r6; T[o + 12] = r7; T[o + 13] = r8;
      T[o + 14] = yl + (_c.r - yl) * 0.84;
      T[o + 15] = yl + (_c.g - yl) * 0.84;
      T[o + 16] = yl + (_c.b - yl) * 0.84;
      T[o + 17] = spread;
      T[o + 18] = per;
      nt++; nom += per;
      if (per > maxPer) maxPer = per;
      if (y0 < ylo) ylo = y0;
      if (y0 > yhi) yhi = y0;
    }
    if (nt < 2 || nom < 12) return null;

    /* ------------------------------------------------------------
       PASS 2 — BLADES, in rank order, straight into the buffers.

       No scratch array, no shuffle, no Matrix4 and no Quaternion: the
       instance matrix is R_tilt * R_yaw * S written by hand, which is
       twelve multiplies and sixteen stores. The pair of Three round
       trips this replaces measured 4.6 ms a chunk on their own.
       ------------------------------------------------------------ */
    const keep = clamp(env.allowedAt(bandNear(band), LOD) + 0.01, 0, 1);
    const n = band <= 0 ? nom : Math.min(nom, Math.max(24, Math.ceil(nom * keep)));

    const geo = BLADE.clone();
    const ranks = new Float32Array(n);
    geo.setAttribute('aFolRank', new THREE.InstancedBufferAttribute(ranks, 1));

    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = `grass.${ci},${cj}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    /* total is the NOMINAL count the ranks are numbered against, not
       the number built — the shader thins on rank, so mesh.count has
       to be read off the same denominator whatever band we are in. */
    mesh.userData.total = nom;
    mesh.userData.built = n;
    mesh.userData.band = band;

    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const MA = mesh.instanceMatrix.array, CA = mesh.instanceColor.array;

    let i = 0;
    for (let j = 0; j < maxPer && i < n; j++) {
      /* ANKLE HEIGHT — AND RANK IS NOT DISTANCE. The lift below is
         meant for the low-rank survivors distance thinning keeps, but
         rank is a static per-instance number, so a 1.8x lift also
         landed on low-rank blades standing a metre from the camera:
         measured against Wally in the same frame, the tallest of them
         hit 0.30 m against his 1.7 m — mid-shin, not ankle, and those
         are exactly the blades that read as separable green shards
         instead of carpet. 0.35 keeps the far field varied without
         ever breaking the 0.11-0.30 m law at the near camera; the
         coverage it used to buy is bought by uFolFat instead.

         Evaluated per ROW rather than per blade. A row spans one
         PER_TUFT-th of the rank range, so the lift inside it varies
         by under a tenth of its own span, and rows are interleaved
         across the whole chunk so there is nothing spatial to band.
         u^1.75 by two square roots, because thirty thousand
         Math.pow() calls a chunk are half a millisecond. */
      const u = clamp(1 - (i + 0.5) / nom, 0, 1);
      const su = Math.sqrt(u);
      const lift = 1 + 0.35 * (u * su * Math.sqrt(su));

      for (let k = 0; k < nt && i < n; k++) {
        const to = k * TSTRIDE;
        if (j >= T[to + 18]) continue;
        _S = (seed ^ Math.imul(k, 0x9e3779b1) ^ Math.imul(j + 1, 0x85ebca6b)) | 0;
        const w0 = R32(), w1 = R32();

        const spread = T[to + 17];
        const du = ((w0 & 2047) * B11 - 0.5) * 2 * spread;
        const dv = (((w0 >>> 11) & 2047) * B11 - 0.5) * 2 * spread;
        const yi = (w0 >>> 22) & 511;
        const cs = YAWC[yi], sn = YAWS[yi];
        const h = (0.110 + (w1 & 2047) * B11 * 0.065) * lift;
        /* survivors also widen slightly, so a blade at 70 m is still a
           blade and not a shimmering sub-pixel needle */
        const wd = h * (0.88 + ((w1 >>> 11) & 2047) * B11 * 0.38) * lift;

        const c0x = T[to + 5], c0y = T[to + 6], c0z = T[to + 7];
        const c2x = T[to + 11], c2y = T[to + 12], c2z = T[to + 13];

        const mo = i * 16;
        MA[mo] = (c0x * cs - c2x * sn) * wd;
        MA[mo + 1] = (c0y * cs - c2y * sn) * wd;
        MA[mo + 2] = (c0z * cs - c2z * sn) * wd;
        MA[mo + 3] = 0;
        MA[mo + 4] = T[to + 8] * h;
        MA[mo + 5] = T[to + 9] * h;
        MA[mo + 6] = T[to + 10] * h;
        MA[mo + 7] = 0;
        MA[mo + 8] = (c0x * sn + c2x * cs) * wd;
        MA[mo + 9] = (c0y * sn + c2y * cs) * wd;
        MA[mo + 10] = (c0z * sn + c2z * cs) * wd;
        MA[mo + 11] = 0;
        MA[mo + 12] = T[to] + du;
        MA[mo + 13] = T[to + 2] + T[to + 3] * du + T[to + 4] * dv;
        MA[mo + 14] = T[to + 1] + dv;
        MA[mo + 15] = 1;

        const j2 = 0.97 + ((w1 >>> 22) & 255) * B8 * 0.10;
        const co = i * 3;
        CA[co] = T[to + 14] * j2;
        CA[co + 1] = T[to + 15] * j2;
        CA[co + 2] = T[to + 16] * j2;

        ranks[i] = (i + 0.5) / nom;
        i++;
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;

    /* ANALYTIC BOUNDS. InstancedMesh.computeBoundingSphere() walks
       every instance matrix — a second full pass over sixty thousand
       blades to rediscover a box we already know: this chunk, plus the
       tuft spread, plus the tallest blade. */
    const half = CHUNK * 0.5;
    const dy = (yhi - ylo) * 0.5 + 0.6;
    mesh.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(ox + half, (ylo + yhi) * 0.5 + 0.15, oz + half),
      Math.sqrt(2 * (half + 0.6) * (half + 0.6) + dy * dy));
    return mesh;
  }

  return {
    name: 'grass',
    range: GRASS_DIST,
    /* must match uFolFlatY above — the CPU cutoff and the shader's
       have to be the same number or chunks pop at the band edges */
    flatY: 0.7,
    material: mat,
    build, setLOD, bandFor,
    lod(mesh, d) {
      /* EXACT, NOT CONSERVATIVE-WITH-A-MARGIN. The shader's fKeep is
         zero for every instance whose rank reaches the cutoff, so
         `total * allowed(nearest corner)` already keeps everything
         that can possibly be visible anywhere in the chunk. The 0.22
         safety margin this used to carry was pure waste: at 120 m the
         curve is at 0.03 and the margin was drawing eight times more
         grass than the shader was willing to show.

         ONE MULTIPLY AND ONE STORE, PER CHUNK — never per instance.
         `built` is the ceiling the chunk's band actually placed; the
         band was chosen from the chunk's NEAREST possible distance so
         it can only ever be at or above what this asks for, but clamp
         anyway rather than trust a float comparison at a boundary. */
      const total = mesh.userData.total;
      const a = env.allowedAt(d, LOD);
      let n = Math.ceil(total * clamp(a + 0.004, 0, 1));
      if (n > mesh.userData.built) n = mesh.userData.built;
      mesh.count = n;
      mesh.visible = n > 0;
    },
    release() {},
    dispose() { BLADE.dispose(); },
  };
}
