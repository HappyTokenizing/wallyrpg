/* ============================================================
   composer.js — a minimal EffectComposer.

   three's addons are not vendored (BUILD_BRIEF), so this is ours. It
   is deliberately smaller than three's: no Pass class hierarchy, no
   read/write buffer bookkeeping inside the passes themselves. postfx.js
   owns the graph and just asks this file to "draw this material into
   that target".

   Two things worth knowing:

   * Full-screen *triangle*, not quad. A quad rasterises the diagonal
     seam twice and splits the wavefront; a single oversized triangle
     with clip-space coordinates baked into the attribute costs one
     draw and no vertex transform at all.

   * Render targets come from a pool keyed by (scale, type). The post
     chain ping-pongs through half a dozen of them per frame and
     allocating on resize only — never per frame — is what keeps
     renderer.info honest.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { FSQ_VERT } from './shaders.js';

export function createComposer(ctx, { width, height }) {
  const renderer = ctx.renderer;

  /* ---- the full-screen triangle ---- */
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));

  const fsqMesh = new THREE.Mesh(geo, null);
  fsqMesh.frustumCulled = false;
  fsqMesh.matrixAutoUpdate = false;

  const fsqScene = new THREE.Scene();
  fsqScene.add(fsqMesh);
  const fsqCam = new THREE.Camera();

  /* ---- render target pool ---- */
  let W = width, H = height;
  const pool = new Map();

  function rtKey(name) { return name; }

  function makeRT(w, h, opts = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      type: opts.type ?? THREE.HalfFloatType,
      format: opts.format ?? THREE.RGBAFormat,
      minFilter: opts.minFilter ?? THREE.LinearFilter,
      magFilter: opts.magFilter ?? THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: opts.depthBuffer ?? false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
      samples: opts.samples ?? 0,
    });
    rt.texture.name = opts.name || 'rt';
    /* A REAL DEPTH TEXTURE, not a renderbuffer. The scene target asks
       for this so the post chain can read the depth the main pass has
       already written instead of re-drawing the whole scene into a
       separate normal+depth buffer. DEPTH_COMPONENT24 is sampled with
       a plain sampler2D (compareFunction stays null — this is not a
       shadow sampler), and three resizes it with the target. */
    if (opts.depthTexture) {
      const dt = new THREE.DepthTexture(rt.width, rt.height);
      dt.format = THREE.DepthFormat;
      dt.type = THREE.UnsignedIntType;
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      dt.generateMipmaps = false;
      dt.name = (opts.name || 'rt') + '.depth';
      rt.depthTexture = dt;
    }
    return rt;
  }

  /* Named, resize-tracked targets. `scale` is relative to the
     viewport; pass an explicit {w,h} for fixed-size buffers. */
  function target(name, scale = 1, opts = {}) {
    const key = rtKey(name);
    let e = pool.get(key);
    if (!e) {
      e = { scale, opts, rt: makeRT(W * scale, H * scale, { ...opts, name }) };
      pool.set(key, e);
    }
    return e.rt;
  }

  function resize(w, h) {
    W = w; H = h;
    for (const e of pool.values()) {
      e.rt.setSize(Math.max(1, Math.round(W * e.scale)), Math.max(1, Math.round(H * e.scale)));
    }
  }

  /* ---- pass construction ---- */
  function makeMaterial(fragmentShader, uniforms = {}, defines = {}) {
    return new THREE.ShaderMaterial({
      vertexShader: FSQ_VERT,
      fragmentShader,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
  }

  /* Draw `material` over `target` (null = canvas).
     `clear: false` leaves the target intact, which is how the bloom
     upsample chain accumulates additively without a copy pass. */
  function draw(material, target, clear = true) {
    const prev = renderer.autoClear;
    renderer.autoClear = clear;
    fsqMesh.material = material;
    renderer.setRenderTarget(target ?? null);
    renderer.render(fsqScene, fsqCam);
    renderer.autoClear = prev;
  }

  function dispose() {
    for (const e of pool.values()) e.rt.dispose();
    pool.clear();
    geo.dispose();
  }

  return {
    get width() { return W; },
    get height() { return H; },
    makeRT, target, resize, makeMaterial, draw, dispose,
    fsqScene, fsqCam, fsqMesh,
  };
}
