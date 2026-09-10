/* ============================================================
   csm.js — cascaded shadow maps.

   ART_DIRECTION §3: "4-cascade CSM, 2048 per cascade, PCF-soft with a
   wide kernel and a generous normal bias. Shadow colour is tinted,
   never black."

   Implementation note. Rather than rolling a private depth pass, each
   cascade is a real THREE.DirectionalLight with castShadow — only
   cascade 0 carries the sun's colour, the rest have zero intensity and
   exist purely to own a shadow map. That means three's whole shadow
   pipeline still applies: castShadow flags, customDepthMaterial (so a
   wind-displaced canopy can cast a wind-displaced shadow), skinning,
   instancing, autoUpdate. The material layer then ignores three's own
   `getShadow` and does its own wide Poisson PCF with per-cascade
   kernel radii chosen so the penumbra is a constant width in *world*
   space across all four cascades.

   Cascade selection is unrolled from JS because GLSL ES 3.00 will not
   let us index a sampler array with a runtime value.

   Stability: each cascade is fitted to the bounding *sphere* of its
   sub-frustum (rotation-invariant) and the centre is snapped to the
   shadow-map texel grid, so the shadow edges do not crawl when the
   camera turns. Without this every wall in the city shimmers.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { GLSL_POISSON } from './shaders.js';

const _center = new THREE.Vector3();
const _lightPos = new THREE.Vector3();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mInv = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _upAlt = new THREE.Vector3(0, 0, 1);
const _corners = [];
for (let i = 0; i < 8; i++) _corners.push(new THREE.Vector3());
const _invProjView = new THREE.Matrix4();

/* The 8 NDC corners of a unit frustum slab. */
const NDC = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

export function createCSM(ctx, opts = {}) {
  const { THREE: T = THREE, scene } = ctx;

  const cfg = {
    cascades: opts.cascades ?? 4,
    mapSize: opts.mapSize ?? 2048,
    near: opts.near ?? 0.6,
    far: opts.far ?? 110,
    lambda: opts.lambda ?? 0.74,
    /* PCF kernel RADIUS in world metres — the delivered penumbra is
       about twice this. The per-cascade UV scaling below exists to
       hold it constant across the whole cascade set.

       It was not constant. At 0.42 the requested kernel was 0.019 UV
       in cascade 0 and the maxUV clamp below is 0.0037, so *every*
       cascade ran pinned to the clamp — which is a fixed number of
       TEXELS, i.e. a penumbra proportional to the cascade's own size.
       Measured at 1400x900: 0.16 m in cascade 0, 0.41 m in cascade 1,
       1.35 m in cascade 2. A wall eleven metres away straddles the
       0/1 split, so its cast shadow was blended between a crisp edge
       and one two and a half times softer over the height of the
       wall — read on screen as a pale blue horizontal band with a
       gradient bottom edge that belonged to no object in the scene.

       0.08 was still not small enough. Cascade 0 fits a sphere of
       radius ~5.5 m, so it asked for 0.08 / 11 = 0.0073 UV against a
       clamp of 7.5 / 2048 = 0.0037 and ran pinned to it exactly as
       before; the visible symptom was the roof's cast shadow on the
       lab wall, whose top edge resolved in 9 px and whose bottom edge
       dissolved over 18 px because the two edges sat either side of
       the 0/1 split. 0.055 against the raised clamp below fits with
       room to spare in every cascade, so the penumbra is finally the
       constant world width this whole block exists to deliver. */
    softWorld: opts.softWorld ?? 0.055,
    margin: opts.margin ?? 70,
    fadeFrac: opts.fadeFrac ?? 0.82,

    /* ------------------------------------------------------------
       THE FAR CASCADE'S CADENCE.

       Every cascade above is a real DirectionalLight with castShadow,
       and three re-rendered EVERY ONE of them EVERY frame:
       renderer.js sets `renderer.shadowMap.needsUpdate = true` before
       the forward pass and WebGLShadowMap then walks the whole scene
       once per light. The far cascade is the expensive one — it is
       fitted to a sphere tens of metres across and so sweeps in every
       building, tree and prop inside it.

       And it re-rendered for nothing. The fit is TEXEL-SNAPPED (see
       the snap in placeCascade below), which is the whole reason the
       far shadows do not crawl when the camera turns: the ortho box
       only ever moves in whole shadow texels. Its contents therefore
       only change when the camera has moved a texel, or when
       something inside it moved — and from ~17 m out to `far`, inside
       the haze and inside the fadeFrac band, nothing in it moves fast
       enough to read at 60 Hz.

       So the far cascade renders on a cadence: `farCadence` frames
       between renders, and on the frames in between IT IS NOT
       RE-FITTED EITHER. That second half is the part that is easy to
       get wrong. three writes `shadow.matrix` inside the shadow
       render (vendor/three.module.js, WebGLShadowMap.render ->
       shadow.updateMatrices), so the matrix the fragment shader
       samples with is the one from the LAST RENDER. Move the light
       without re-rendering and the shadow coordinates address a map
       drawn from somewhere else, which is a whole-screen shadow
       smear, not a saving.

       `farPad` is what makes the skip safe rather than lucky: a
       cadenced cascade is fitted to a sphere `1 + farPad` times the
       one it needs, so a few frames of camera motion still land
       inside the box that was actually rendered. And it is CHECKED
       rather than assumed — update() re-renders immediately, cadence
       or not, the moment the live sub-frustum sphere stops being
       contained in the rendered one, or the sun turns. A cascade can
       therefore never be sampled outside the box it was drawn for, so
       the failure this could have caused — a band of missing far
       shadow while the camera runs — cannot happen; the worst it can
       do is spend a frame it meant to save.

       farCadence = 1 is the rule this replaced, exactly, and
       `WALLY.debug.shadowCadence(1)` / `(3)` switches between them on
       one page load. A single-cascade tier ignores it: on `low` the
       only cascade there is is the near one, and that one carries
       Wally. */
    farCadence: opts.farCadence ?? 3,
    farPad: opts.farPad ?? 0.04,
  };

  const group = new T.Group();
  group.name = 'csm';
  scene.add(group);

  const lights = [];
  const sunDir = new T.Vector3(0.46, 0.72, 0.52).normalize();   // surface -> sun
  const sunColor = new T.Color().setHex(0xfff4dc, T.SRGBColorSpace);
  let sunIntensity = 1.25;

  for (let i = 0; i < cfg.cascades; i++) {
    const l = new T.DirectionalLight(0xffffff, i === 0 ? sunIntensity : 0);
    l.color.copy(sunColor);
    l.castShadow = true;
    l.shadow.mapSize.set(cfg.mapSize, cfg.mapSize);
    l.shadow.camera.near = 0.1;
    l.shadow.camera.far = 400;
    l.shadow.bias = -0.0004;
    l.shadow.normalBias = 0.06;
    l.shadow.intensity = 1.0;
    /* PER-LIGHT GATE. WebGLShadowMap skips a light whose shadow has
       `autoUpdate === false && needsUpdate === false` (vendor bundle,
       the `continue` inside its render loop). Every cascade is opted
       out here so update() below decides, per cascade, per frame; the
       near cascades simply get `needsUpdate = true` every frame, which
       is byte-for-byte the behaviour they had. */
    l.shadow.autoUpdate = false;
    l.shadow.needsUpdate = true;
    l.matrixAutoUpdate = true;
    l.name = `csm-cascade-${i}`;
    group.add(l);
    group.add(l.target);
    lights.push(l);
  }

  /* Where each cascade's shadow map was last RENDERED from — the
     snapped centre, the padded radius the ortho box was built at, and
     the sun direction it was drawn under. A skipped cascade must not
     be re-fitted, so this is the fit that is still on screen. */
  const fits = [];
  for (let i = 0; i < cfg.cascades; i++) {
    fits.push({ center: new T.Vector3(), radius: 0, sun: new T.Vector3(), frame: -1e9, valid: false });
  }
  const _live = new T.Vector3();
  /* frameNo IS THE CADENCE'S OWN CLOCK AND stats() MUST NOT RESET IT.
     It did, in the first cut of this: zeroing frameNo while fits[i].frame
     kept its old absolute value made `frameNo - f.frame` hugely negative,
     the beat could never come due again, and the far cascade then
     re-rendered only when the containment test fired. The measurement
     had switched the thing it was measuring off. The window counters
     below are separate for exactly that reason. */
  let frameNo = 0;
  let renders = 0, skips = 0;   // cascade shadow renders taken / avoided
  let winFrames = 0, byBeat = 0, byDrift = 0, bySun = 0;

  /* Uniforms the material layer binds by reference. */
  const uniforms = {
    uCsmSplits: { value: new T.Vector4(1e6, 1e6, 1e6, 1e6) },
    uCsmBlur:   { value: new T.Vector4(0.001, 0.001, 0.001, 0.001) },
    uCsmFade:   { value: new T.Vector2(cfg.far * cfg.fadeFrac, cfg.far) },
    uSunDir:    { value: sunDir },
    uSunColor:  { value: sunColor },
    uSunIntensity: { value: sunIntensity },
  };

  const splits = new Array(cfg.cascades + 1).fill(0);

  /* ------------------------------------------------------------------
     GLSL. Generated so the cascade count is baked in and every sampler
     index is a literal.
     ------------------------------------------------------------------ */
  function fragmentGLSL() {
    const N = cfg.cascades;
    const comp = ['x', 'y', 'z', 'w'];

    const sample = (i) => `wCsmPCF( directionalShadowMap[ ${i} ], vDirectionalShadowCoord[ ${i} ], ` +
      `directionalLightShadows[ ${i} ].shadowBias, uCsmBlur.${comp[i]}, cs, sn )`;

    let sel = '';
    for (let i = 0; i < N; i++) {
      const s = `uCsmSplits.${comp[i]}`;
      const head = i === 0 ? `if ( viewZ < ${s} ) {` : `} else if ( viewZ < ${s} ) {`;
      sel += `  ${head}\n    sh = ${sample(i)};\n`;
      if (i < N - 1) {
        sel += `    float b${i} = smoothstep( ${s} * 0.84, ${s}, viewZ );\n`;
        sel += `    if ( b${i} > 0.0 ) sh = mix( sh, ${sample(i + 1)}, b${i} );\n`;
      }
    }
    sel += `  } else {\n    sh = 1.0;\n  }\n`;

    return /* glsl */`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS >= ${N}
  #define WALLY_CSM 1
${GLSL_POISSON}
  uniform vec4 uCsmSplits;
  uniform vec4 uCsmBlur;
  uniform vec2 uCsmFade;

  float wCsmPCF( sampler2D map, vec4 sc, float bias, float blur, float cs, float sn ) {
    vec3 p = sc.xyz / sc.w;
    p.z += bias;
    if ( p.z > 1.0 ) return 1.0;
    vec2 e = min( p.xy, 1.0 - p.xy );
    if ( min( e.x, e.y ) < 0.0 ) return 1.0;
    // shrink the kernel near the map border so we never smear in
    // garbage from outside the cascade
    float b = blur * smoothstep( 0.0, blur * 2.0, min( e.x, e.y ) );
    float sum = 0.0;
    for ( int i = 0; i < 12; i ++ ) {
      vec2 o = W_POISSON12[ i ];
      o = vec2( o.x * cs - o.y * sn, o.x * sn + o.y * cs ) * b;
      sum += texture2DCompare( map, p.xy + o, p.z );
    }
    return sum * 0.08333333;
  }

  float wCsmShadow( float viewZ, float rot ) {
    if ( ! receiveShadow ) return 1.0;
    float cs = cos( rot ), sn = sin( rot );
    float sh = 1.0;
${sel}
    sh = mix( sh, 1.0, smoothstep( uCsmFade.x, uCsmFade.y, viewZ ) );
    return mix( 1.0, sh, directionalLightShadows[ 0 ].shadowIntensity );
  }
#else
  float wCsmShadow( float viewZ, float rot ) { return 1.0; }
#endif
`;
  }

  /* ------------------------------------------------------------------
     Per-frame fit.
     ------------------------------------------------------------------ */
  function computeSplits(camera) {
    const near = Math.max(camera.near, cfg.near);
    const far = cfg.far;
    const N = cfg.cascades;
    splits[0] = near;
    for (let i = 1; i <= N; i++) {
      const p = i / N;
      const log = near * Math.pow(far / near, p);
      const uni = near + (far - near) * p;
      splits[i] = cfg.lambda * log + (1 - cfg.lambda) * uni;
    }
    /* Slots past the cascade count repeat the last split, so the
       generated `viewZ < split` chain can never select a cascade we
       did not render. */
    const v = uniforms.uCsmSplits.value;
    const at = (i) => splits[Math.min(i, N)];
    v.set(at(1), at(2), at(3), at(4));
    uniforms.uCsmFade.value.set(far * cfg.fadeFrac, far);
  }

  /* The sub-frustum's bounding SPHERE in world space — rotation
     invariant, so the fit does not change when the camera turns.
     Writes the centre into `out` and returns the radius. Reads
     nothing that a shadow render writes, so it is safe to call on a
     frame whose cascade will be skipped: this is what the containment
     test below compares the rendered fit against. */
  function subSphere(camera, zNear, zFar, out) {
    /* Sub-frustum corners in world space: unproject the full frustum
       once, then lerp each near->far edge to the split distances. */
    _invProjView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    for (let c = 0; c < 8; c++) {
      _corners[c].set(NDC[c][0], NDC[c][1], NDC[c][2]).applyMatrix4(_invProjView);
    }
    /* corners 0..3 are near, 4..7 far — lerp to the split distances */
    const t0 = (zNear - camera.near) / (camera.far - camera.near);
    const t1 = (zFar - camera.near) / (camera.far - camera.near);
    for (let c = 0; c < 4; c++) {
      const n = _corners[c], f = _corners[c + 4];
      _v.copy(f).sub(n);
      const nx = n.x + _v.x * t0, ny = n.y + _v.y * t0, nz = n.z + _v.z * t0;
      const fx = n.x + _v.x * t1, fy = n.y + _v.y * t1, fz = n.z + _v.z * t1;
      n.set(nx, ny, nz);
      f.set(fx, fy, fz);
    }

    out.set(0, 0, 0);
    for (let c = 0; c < 8; c++) out.add(_corners[c]);
    out.multiplyScalar(1 / 8);

    let radius = 0;
    for (let c = 0; c < 8; c++) radius = Math.max(radius, out.distanceTo(_corners[c]));
    return Math.ceil(radius * 16) / 16;      // quantise so it does not breathe
  }

  /* Point cascade `i` at a sphere and rebuild its ortho box. THIS IS
     THE ONLY THING THAT MOVES A CASCADE LIGHT, and it is called only
     on a frame whose shadow map is about to be re-rendered — see the
     cadence block at the top of this file for why the two cannot be
     separated. Records the fit it delivered in fits[i]. */
  function placeCascade(i, center, radius) {
    const light = lights[i];
    _center.copy(center);

    /* light basis (depends only on sunDir, so snapping is safe) */
    const up = Math.abs(sunDir.y) > 0.985 ? _upAlt : _up;
    _lightPos.copy(_center).addScaledVector(sunDir, radius + cfg.margin);
    _m.lookAt(_lightPos, _center, up);
    _m.setPosition(_lightPos);
    _mInv.copy(_m).invert();

    /* texel snap */
    const texel = (2 * radius) / cfg.mapSize;
    _v.copy(_center).applyMatrix4(_mInv);
    _v.x = Math.round(_v.x / texel) * texel;
    _v.y = Math.round(_v.y / texel) * texel;
    _v.applyMatrix4(_m);
    _center.copy(_v);
    _lightPos.copy(_center).addScaledVector(sunDir, radius + cfg.margin);

    light.position.copy(_lightPos);
    light.target.position.copy(_center);
    light.target.updateMatrixWorld();

    const cam = light.shadow.camera;
    cam.left = -radius; cam.right = radius;
    cam.top = radius; cam.bottom = -radius;
    cam.near = 0.1;
    cam.far = 2 * radius + cfg.margin * 2;
    cam.updateProjectionMatrix();

    /* Normal bias scaled to the cascade's texel size — this is what
       keeps the wide PCF kernel from self-shadowing into acne on
       Wally's cranium. "Generous" has a cost, though: the receiver is
       displaced along its own normal, so on a wall lit from 34 degrees
       a 0.015 m bias walks the shadow boundary ~0.02 m down the wall
       and opens a lit sliver under every eave in the city. The
       delivered penumbra is now 0.055 m, so the bias no longer has to
       cover a 0.16 m kernel and comes down to match. */
    light.shadow.normalBias = Math.max(0.008, texel * 1.15);
    light.shadow.bias = -0.0007 * Math.max(1, radius / 24);

    /* Constant world-space penumbra: kernel radius in shadow UV.
       maxUV exists to stop a huge far cascade smearing garbage; at
       7.5 texels it was tighter than cascade 0's own request and so
       became the thing that decided the penumbra. 11 texels is still a
       hard stop and no longer binds anywhere. */
    const blurUV = cfg.softWorld / (2 * radius);
    const minUV = 1.0 / cfg.mapSize;
    const maxUV = 11.0 / cfg.mapSize;
    const comp = ['x', 'y', 'z', 'w'][i];
    uniforms.uCsmBlur.value[comp] = Math.min(maxUV, Math.max(minUV, blurUV));

    const f = fits[i];
    f.center.copy(_center);
    f.radius = radius;
    f.sun.copy(sunDir);
    f.frame = frameNo;
    f.valid = true;
  }

  /* How many frames this cascade may go between renders. Only the
     LAST cascade is cadenced, and only when there is more than one —
     the near cascades carry everything the eye is actually on. */
  const cadenceOf = (i) =>
    (cfg.cascades >= 2 && i === cfg.cascades - 1) ? Math.max(1, cfg.farCadence | 0) : 1;

  /* Is the fit currently on screen still good enough to sample? The
     ortho box is +-f.radius in the light's XY and (much) deeper than
     that along the light axis, so sphere containment is the
     conservative test for the box as well. */
  /* Anything that changes what a cascade's map MEANS — its size, the
     distance it covers, the cadence itself — throws the recorded fits
     away, so the next update() re-renders every cascade rather than
     sampling a map drawn under the old rule. */
  function invalidate() { for (const f of fits) f.valid = false; }

  /* The sun turning re-projects the whole map. SUN_EPS is 1.3 degrees:
     the shadow direction may lag the light by that much between two
     renders of the same cascade, which at the far cascade's own texel
     (2*radius / mapSize — 0.055 m at radius 49, mapSize 1792) is under
     one texel for anything up to about 2.4 m tall standing on the
     ground. Tighter than this and an ordinary day cycle re-renders the
     cascade every frame all by itself, which is the cadence switched
     off without saying so — the first cut of this file used 0.6 deg
     and did exactly that. */
  const SUN_EPS = Math.cos(1.3 * Math.PI / 180);

  /* WHY this cascade must be re-rendered this frame, or null for "the
     map on screen is still the right map". Named rather than boolean
     because the three reasons mean completely different things about
     whether the cadence is doing anything: 'beat' is the cadence
     working, 'drift' says farPad is too small for how fast the camera
     is moving, and 'sun' says the day cycle is turning faster than
     SUN_EPS allows. stats() counts them apart, so "the cadence saved
     nothing here" can never be read as "the cadence is on". */
  function dueReason(f, center, radius, cadence) {
    if (cadence <= 1 || !f.valid) return 'beat';
    if (f.sun.dot(sunDir) <= SUN_EPS) return 'sun';
    /* The ortho box is +-f.radius in the light's XY and much deeper
       than that along the light axis, so sphere containment is the
       conservative test for the box as well. */
    if (f.center.distanceTo(center) + radius > f.radius) return 'drift';
    if ((frameNo - f.frame) >= cadence) return 'beat';
    return null;
  }

  const api = {
    cfg,
    lights,
    group,
    uniforms,
    sunDir,
    sunColor,
    get sunIntensity() { return sunIntensity; },
    glsl: fragmentGLSL,

    /* The sky module drives this. `dir` points FROM the surface TOWARD
       the sun, i.e. the same convention as the shader's L. */
    setSun(dir, color, intensity) {
      if (dir) sunDir.copy(dir).normalize();
      if (color !== undefined && color !== null) {
        if (typeof color === 'number') sunColor.setHex(color, THREE.SRGBColorSpace);
        else sunColor.copy(color);
        for (const l of lights) l.color.copy(sunColor);
      }
      if (intensity !== undefined) {
        sunIntensity = intensity;
        uniforms.uSunIntensity.value = intensity;
        lights[0].intensity = intensity;
      }
    },

    setFar(far) { cfg.far = far; invalidate(); },

    setMapSize(size) {
      cfg.mapSize = size;
      for (const l of lights) {
        l.shadow.mapSize.set(size, size);
        if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
      }
      invalidate();
    },

    /* THE A/B, ON ONE PAGE LOAD. 1 is the rule this replaced — every
       cascade re-rendered every frame — and the shipping default is
       cfg.farCadence. Returns the cadence now in force. Driven from
       WALLY.debug.shadowCadence() in renderer.js. */
    setFarCadence(n) {
      const want = Math.max(1, Math.min(60, n | 0));
      if (want !== cfg.farCadence) { cfg.farCadence = want; invalidate(); }
      return cfg.farCadence;
    },

    /* Load-independent evidence: how many cascade shadow renders were
       taken and how many were skipped, since the last reset. A frame
       count is not enough — the cadence also renders early whenever
       the containment test fires, and that is the number that says
       whether it is really saving anything where the camera moves. */
    stats(reset) {
      const s = {
        cascades: cfg.cascades,
        farCadence: cfg.farCadence,
        farPad: cfg.farPad,
        frames: winFrames,
        renders,
        skips,
        /* which of the three things brought a cadenced cascade back
           early, or on time — see dueReason() */
        beat: byBeat, drift: byDrift, sun: bySun,
        perFrame: winFrames ? +(renders / winFrames).toFixed(4) : 0,
      };
      /* frameNo is deliberately NOT reset — see its declaration. */
      if (reset) { renders = 0; skips = 0; winFrames = 0; byBeat = 0; byDrift = 0; bySun = 0; }
      return s;
    },

    update(camera) {
      frameNo++; winFrames++;
      computeSplits(camera);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      for (let i = 0; i < cfg.cascades; i++) {
        const cadence = cadenceOf(i);
        const f = fits[i];
        /* Cheap and unconditional: we have to know where the cascade
           WANTS to be before we can say the fit on screen still covers
           it. This is matrix arithmetic on eight points, not a draw. */
        const r = subSphere(camera, splits[i], splits[i + 1], _live);
        const why = dueReason(f, _live, r, cadence);
        if (why) {
          placeCascade(i, _live, cadence > 1 ? Math.ceil(r * (1 + cfg.farPad) * 16) / 16 : r);
          renders++;
          if (cadence > 1) {
            if (why === 'sun') bySun++; else if (why === 'drift') byDrift++; else byBeat++;
          }
        } else {
          skips++;
        }
        lights[i].shadow.needsUpdate = !!why;
      }
      group.updateMatrixWorld(true);
    },

    dispose() {
      for (const l of lights) {
        l.shadow.map?.dispose();
        l.parent?.remove(l);
        l.target.parent?.remove(l.target);
      }
      scene.remove(group);
    },
  };

  return api;
}
