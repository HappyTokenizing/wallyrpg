/* ============================================================
   silhouette.js — ctx.render.silhouette: cheap off-screen mask passes.

   WHAT THIS IS FOR, AND WHY IT EXISTS AS A RENDER-LAYER SERVICE.

   Several effects in this game want the SHAPE of one object, rendered
   from somewhere that is not the main camera, into a small target:
   Wally's deferred ground-shadow projector (character/wally.js) is the
   first, a light-shaft mask or a stencil-style highlight would be the
   next. The obvious way to write that is

       scene.overrideMaterial = flatWhite;
       camera.layers.set( PRIVATE_LAYER );
       renderer.render( scene, camera );

   and it is a trap. `renderer.render( scene, ... )` walks the WHOLE
   scene graph in projectObject() before it can discover that the
   layer mask rejects all but seven meshes. MEASURED, in the city, on
   an M1 Max, at 1600x900, high tier:

     scene graph                       9 704 objects, 2 250 meshes
     meshes actually on the layer              7
     draw calls issued                         7
     cost of the pass                       1.99 ms of CPU, every frame

   and — the number that settles the design — rendering the same pass
   into a 160 px target instead of a 320 px one costs 1.98 ms. The
   rasteriser is not in this. NONE of that 2 ms is pixels; it is
   9 704 layer tests, matrix refreshes and frustum culls to find seven
   meshes we already knew the identity of. Shrinking the target, or
   blurring harder to hide a smaller one, buys exactly nothing.

   THE FIX IS TO TRAVERSE THE SUBTREE INSTEAD OF THE SCENE. three's
   renderer.render() accepts any Object3D as its first argument, not
   just a Scene — it guards every Scene-only branch (background, fog,
   overrideMaterial, onBeforeRender) behind `scene.isScene === true`.
   Hand it the object you actually want and projectObject() walks 42
   nodes instead of 9 704. The one thing you give up is
   `scene.overrideMaterial`, which is a Scene-only field, so this file
   swaps materials on the subtree's meshes by hand and puts them back —
   over 42 nodes that is free.

     same 7 draw calls, same 320 px target, bit-identical output
     (0 differing pixels of 102 400, across five poses)

     whole-scene + overrideMaterial      1.99 ms
     subtree + material swap             0.06 ms      -97 %

   CADENCE, INVESTIGATED AND REJECTED. The obvious next move is to stop
   re-rendering the mask every frame. Measured over 150 frames of idle,
   with the mask reduced to 16x16 blocks (which is roughly what the
   projector's 17-tap ring blur leaves of it), the frame-to-frame
   change is 0.023 % mean and 1.3 % worst-block. So a dirty flag would
   be defensible on IDLE — and it would save 0.06 ms, while going
   stale exactly when it is most visible, which is when he is running
   and the mask changes fastest. The pass is no longer worth a cache.
   The traversal was the whole bill.

   USAGE — see the header of render(), and ctx.render.silhouette.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';

/* Mask resolution per quality tier. These are the sizes the ground
   shadow was authored against; do not change them without re-shooting
   the contact shadow, because the projector's blur radius is in mask
   UV and a different size is a different penumbra. */
const TIER_SIZE = { low: 128, med: 224, high: 320, ultra: 320 };
const tierName = (n) => String(n || 'high').replace(/\(.*/, '');

/* Flat-white coverage. Same include chain as renderer.js's own
   depth+normal prepass material minus the normal, because a mask only
   wants to know "is there geometry here".

   <batching_pars_vertex> and <skinning_pars_vertex> are both here so a
   skinned character and a batched prop produce the same mask; the
   chunks compile to nothing when the mesh does not use them, and
   instancing is handled inside <project_vertex> for free. There are
   deliberately NO morph chunks: nothing in this game morphs, and
   adding them would change the compiled program for no coverage. */
const WHITE_VERT = /* glsl */`
  #include <common>
  #include <batching_pars_vertex>
  #include <skinning_pars_vertex>
  void main() {
    #include <batching_vertex>
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    #include <project_vertex>
  }
`;

export function createSilhouette(ctx) {
  const renderer = ctx.renderer;

  /* ---------------- materials ---------------- */

  /* Unlit white, double sided. DoubleSide because a mask must not open
     a hole where a surface faces away — an ear fan seen edge-on is one
     triangle layer, and back-face culling would drop half of it. */
  const whiteMat = new THREE.ShaderMaterial({
    name: 'render.silhouette.white',
    vertexShader: WHITE_VERT,
    fragmentShader: /* glsl */`void main() { gl_FragColor = vec4( 1.0 ); }`,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });

  /* Linear view depth in all four channels, for callers that want to
     know how FAR the shape is rather than only that it is there — a
     projector that wants to fade with distance from the caster, or a
     mask that has to resolve self-occlusion. Front faces only: a depth
     mask wants the near surface, and DoubleSide would let a back face
     win the depth test at a grazing angle. */
  const depthMat = new THREE.ShaderMaterial({
    name: 'render.silhouette.depth',
    vertexShader: /* glsl */`
      #include <common>
      #include <batching_pars_vertex>
      #include <skinning_pars_vertex>
      varying float vZ;
      void main() {
        #include <batching_vertex>
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vZ = - mvPosition.z;
      }
    `,
    fragmentShader: /* glsl */`
      varying float vZ;
      void main() { gl_FragColor = vec4( vZ ); }
    `,
    side: THREE.FrontSide,
    toneMapped: false,
    fog: false,
  });

  /* ---------------- targets ---------------- */

  const targets = new Map();   // key -> { rt, base }

  function sizeForTier(base) {
    const s = TIER_SIZE[tierName(ctx.quality?.name)] ?? 320;
    return base ? Math.max(16, Math.round(base * (s / 320))) : s;
  }

  /* A shared, pooled mask target. Byte RGBA with LinearFilter, clamped
     (so the projector's blur taps at the rim do not wrap a limb around
     to the other side), no mipmaps, NoColorSpace — the mask is
     coverage, not colour, and must not be sRGB-encoded on write.

     `base` is the size you would want at the `high` tier; the tier
     scale is applied for you. Pass `{ exact: n }` to opt out. */
  function target(key, base = 320, opts = {}) {
    let e = targets.get(key);
    const n = opts.exact ? Math.max(16, opts.exact | 0) : sizeForTier(base);
    if (!e) {
      const rt = new THREE.WebGLRenderTarget(n, n, {
        type: opts.type ?? THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: opts.depthBuffer ?? true,
        stencilBuffer: false,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace,
        samples: 0,
      });
      rt.texture.name = `silhouette.${key}`;
      e = { rt, base: opts.exact ? null : base };
      targets.set(key, e);
    } else if (e.rt.width !== n) {
      e.rt.setSize(n, n);
    }
    return e.rt;
  }

  /* ---------------- the pass ---------------- */

  /* Reusable swap bookkeeping. Grows once to the largest subtree ever
     rendered and never allocates again. */
  const swapObjs = [];
  const swapMats = [];
  let swapCount = 0;

  const _prevClear = new THREE.Color();
  const _black = new THREE.Color(0, 0, 0);

  /**
   * Render `object` — and nothing else in the scene — into `rt`.
   *
   *   ctx.render.silhouette.render( wallyRoot, shCam, shRT );
   *
   * `object` is any Object3D; only its subtree is traversed, which is
   * the whole point of this file. It may still be parented into the
   * live scene: its world matrix is resolved through its real parent,
   * so nothing has to be detached or mirrored.
   *
   * `camera.layers` still filters, exactly as it did when this was a
   * whole-scene pass, so an existing private-layer setup keeps working
   * unchanged — it is now a second filter on top of the subtree rather
   * than the only one.
   *
   * opts:
   *   material  'white' (default) | 'depth' | null  (null keeps the
   *             meshes' own materials — an albedo mask)
   *   clear     true (default). Colour+depth, to `clearColor`.
   *   clearColor  THREE.Color, default black
   *   clearAlpha  default 0
   *
   * Every piece of renderer state this touches is saved and restored,
   * including shadowMap.needsUpdate — leaving that true here would
   * make three re-render every shadow cascade for a 320 px mask, which
   * is a 443-draw-call mistake that costs more than the frame it was
   * meant to help.
   */
  function render(object, camera, rt, opts = {}) {
    if (!object || !camera || !rt) return false;

    const mode = opts.material === undefined ? 'white' : opts.material;
    const mat = mode === 'white' ? whiteMat : mode === 'depth' ? depthMat : null;

    /* Collect the subtree. Re-collected every call rather than cached:
       over ~40 nodes it is microseconds, and a cache here would be a
       staleness bug the first time the character module attaches a
       prop to a hand. */
    if (mat) {
      swapCount = 0;
      object.traverse((o) => {
        if (o.isMesh !== true) return;
        swapObjs[swapCount] = o;
        swapMats[swapCount] = o.material;
        o.material = mat;
        swapCount++;
      });
    }

    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevNeed = renderer.shadowMap.needsUpdate;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_prevClear);

    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(rt);
    /* Clear explicitly, then hold autoClear DOWN so three does not
       clear the same target a second time on its way into render().
       The two clears are identical, so dropping the second one cannot
       change a pixel — it just stops the pass paying for it twice. */
    if (opts.clear !== false) {
      renderer.setClearColor(opts.clearColor || _black, opts.clearAlpha ?? 0);
      renderer.clear(true, true, false);
    }
    renderer.autoClear = false;
    renderer.render(object, camera);

    if (mat) {
      for (let i = 0; i < swapCount; i++) {
        swapObjs[i].material = swapMats[i];
        swapObjs[i] = null; swapMats[i] = null;
      }
      swapCount = 0;
    }

    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.needsUpdate = prevNeed;
    renderer.setClearColor(_prevClear, prevAlpha);
    return true;
  }

  /* ---------------- aiming ---------------- */

  const _sd = new THREE.Vector3();
  const _c = new THREE.Vector3();

  /**
   * Point an orthographic camera down the sun at `center`, with the
   * two corrections a sun-aligned projector needs to stay legible:
   *
   *   - below `minY` the sun is on the horizon and a true projection
   *     is a forty-metre smear that reads as a stripe, so the
   *     direction is flattened toward the vertical by `flatten`;
   *   - above that, the zenith angle is capped at atan(`rake`) so the
   *     shape stays under the caster at every hour.
   *
   * Writes camera.position / up / quaternion and, if `outVP` is given,
   * the mask's view-projection matrix. Returns the raked direction.
   */
  function aimSun(camera, center, opts = {}) {
    const dist = opts.dist ?? 3.2;
    const rake = opts.rake ?? 0.86;
    const minY = opts.minY ?? 0.12;
    const flatten = opts.flatten ?? 0.25;

    const sun = opts.sun || ctx.mat?.globals?.uSunDir?.value;
    if (sun && sun.lengthSq() > 0.25) _sd.copy(sun).normalize();
    else _sd.set(-0.42, 0.88, 0.22).normalize();

    if (_sd.y < minY) _sd.set(_sd.x * flatten, 1.0, _sd.z * flatten).normalize();
    const hor = Math.hypot(_sd.x, _sd.z);
    const maxHor = _sd.y * rake;
    if (hor > maxHor && hor > 1e-5) {
      const k = maxHor / hor;
      _sd.set(_sd.x * k, _sd.y, _sd.z * k).normalize();
    }

    _c.copy(center);
    camera.position.copy(_c).addScaledVector(_sd, dist);
    camera.up.set(0, 1, 0);
    /* Straight down: `up` is parallel to the view and lookAt degenerates. */
    if (_sd.y > 0.995) camera.up.set(0, 0, 1);
    camera.lookAt(_c);
    camera.updateMatrixWorld(true);
    if (opts.outVP) opts.outVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    return _sd;
  }

  /** An ortho camera sized for a mask of `ext` metres half-extent. */
  function makeCamera(ext = 1.06, near = 0.05, far = 7.0, layer = null) {
    const c = new THREE.OrthographicCamera(-ext, ext, ext, -ext, near, far);
    if (layer !== null) c.layers.set(layer);
    c.matrixAutoUpdate = true;
    return c;
  }

  function dispose() {
    for (const e of targets.values()) e.rt.dispose();
    targets.clear();
    whiteMat.dispose();
    depthMat.dispose();
  }

  /* Tier change resizes every pooled mask that asked for a tier size. */
  const offQuality = ctx.bus.on('quality', () => {
    for (const [key, e] of targets) {
      if (e.base == null) continue;
      const n = sizeForTier(e.base);
      if (e.rt.width !== n) e.rt.setSize(n, n);
      void key;
    }
  });

  return {
    render,
    target,
    aimSun,
    makeCamera,
    sizeForTier,
    materials: { white: whiteMat, depth: depthMat },
    dispose() { offQuality(); dispose(); },
  };
}
