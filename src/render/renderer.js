/* ============================================================
   renderer.js — ctx.render, the frame pipeline.

   ART_DIRECTION §3, in this exact order:

     1  main forward pass           (this file, + CSM shadow maps)
     2  normal + depth resolve       (postfx.js, from the depth buffer)
     3  inverted-hull outline       (drawn inside 2 — see toon.js)
     4  SSAO                        (postfx.js)
     5  bloom                       (postfx.js)
     6  depth of field              (postfx.js)
     7  ACES + lift/gamma/gain      (postfx.js)
     8  film grain                  (postfx.js)
     9  vignette                    (postfx.js)
    10  FXAA                        (postfx.js)

   The outline is step 3 in the document but it is *geometry*, not a
   screen-space pass: every outlined mesh carries a back-faced hull
   child that expands along the view-space normal. It therefore draws
   inside the main forward pass, sorts correctly against everything
   else in the depth buffer for free, and costs one extra draw call
   rather than a full-screen re-render of the scene. Functionally
   identical, materially cheaper.

   Everything up to the composite lives in HalfFloat linear light.
   three's own tone mapping is switched off here because we do ACES
   ourselves after bloom and DOF, which is the only order that gives
   Wind Waker's generous, non-clipping bloom.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { createComposer } from './composer.js';
import { createPostFX, GRADES } from './postfx.js';
import { createCSM } from './csm.js';
import { createSilhouette } from './silhouette.js';
import { SKY } from '../core/palette.js';

/* Shadow-far per tier: the cascade set has to cover the readable
   world, not the whole island.

   These came down (high 110 -> 92, ultra 140 -> 112) because the last
   cascade was being asked to cover ground that cannot show a shadow.
   csm.js fades the set out over `fadeFrac`..1 of this distance — the
   top 18 % — and §2.4 has haze pulling everything toward #B8DEF0 from
   120 m, so at the old ultra setting cascade 3 was fitted to a 152 m
   sphere, swept in every building and prop within it, and spent that
   on a band whose shadows were simultaneously fading to nothing and
   being washed out by haze. The cascade set is fitted to the camera
   sub-frusta, so pulling `far` in shrinks all four spheres, which is
   what takes objects out of the cascades rather than just clipping
   them. Shadows still reach well past anything you can read. */
const SHADOW_FAR = { low: 45, med: 70, high: 92, ultra: 112 };
/* pickQuality() can hand back names like 'high(sw)' for SwiftShader. */
const tierName = (n) => String(n || 'high').replace(/\(.*/, '');

export async function init(ctx) {
  const { renderer, scene } = ctx;
  const q = ctx.quality;

  /* ---------------- renderer configuration ---------------- */
  renderer.autoClear = true;
  renderer.autoClearColor = true;
  renderer.autoClearDepth = true;
  renderer.toneMapping = THREE.NoToneMapping;      // ACES happens in post
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  /* PCFSoft gives us three's RGBA-packed depth maps, which is the
     format our own wide Poisson kernel in csm.js samples. VSM (the
     boot default) would light-bleed through Wally's ears. */
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;           // we drive it per frame
  renderer.setPixelRatio(q.pixelRatio);
  renderer.setClearColor(new THREE.Color().setHex(SKY.horizon, THREE.SRGBColorSpace), 1);
  /* One frame is many render() calls now; let main.js see the total. */
  renderer.info.autoReset = false;

  const dbs = new THREE.Vector2();
  renderer.getDrawingBufferSize(dbs);
  let W = Math.max(1, Math.round(dbs.x));
  let H = Math.max(1, Math.round(dbs.y));

  /* ---------------- targets ---------------- */
  const composer = createComposer(ctx, { width: W, height: H });
  /* The scene target owns a real depth TEXTURE now — see the resolve
     pass at the top of postfx.js. That one full-screen un-projection
     is what the depth+normal prepass below has been replaced by. */
  const rtScene = composer.target('main.scene', 1, { depthBuffer: true, depthTexture: true });
  const rtND = composer.target('main.nd', 1, { depthBuffer: true });

  /* ---------------- shadows ---------------- */
  const csm = createCSM(ctx, {
    cascades: Math.max(1, q.shadowCascades),
    mapSize: q.shadowSize,
    far: SHADOW_FAR[tierName(q.name)] ?? 110,
    softWorld: q.shadowSoft ? 0.055 : 0.025,
  });

  /* ---------------- off-screen mask passes ---------------- */
  /* Shared flat-white / depth mask service for anything that needs the
     SHAPE of one object from somewhere that is not the main camera —
     Wally's ground-shadow projector is the first customer. It exists
     here rather than in the character module because the expensive
     part of that technique is a whole-scene traversal that only the
     render layer is in a position to delete. See silhouette.js. */
  const silhouette = createSilhouette(ctx);

  /* ---------------- post ---------------- */
  const post = createPostFX(ctx, { composer });
  post.setGrade('day');

  /* ================================================================
     Depth + normal prepass material.

     View-space normal in RGB, *linear* view depth in A. Linear depth
     rather than the hardware depth buffer because SSAO and DOF both
     want metres, and reading a DepthTexture then un-projecting costs
     more ALU than just writing the number we already have.
     ================================================================ */
  const ndMaterial = new THREE.ShaderMaterial({
    name: 'wally.prepass',
    vertexShader: /* glsl */`
      #include <common>
      #include <batching_pars_vertex>
      #include <skinning_pars_vertex>
      varying vec3 vN;
      varying float vZ;
      void main() {
        #include <batching_vertex>
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vN = normalize( transformedNormal );
        vZ = - mvPosition.z;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vN;
      varying float vZ;
      void main() {
        gl_FragColor = vec4( normalize( vN ) * 0.5 + 0.5, vZ );
      }
    `,
    uniforms: {},
  });

  /* Material swap bookkeeping for the prepass. Pre-allocated; the
     prepass must not allocate per frame. */
  const swapObjs = [];
  const swapMats = [];
  let swapCount = 0;

  function pushSwap(o, m) {
    swapObjs[swapCount] = o;
    swapMats[swapCount] = m;
    swapCount++;
  }

  function collectAndSwap() {
    swapCount = 0;
    scene.traverseVisible((o) => {
      if (o.isMesh !== true) return;
      if (o.userData.noPrepass === true) {
        pushSwap(o, undefined);
        o.visible = false;
        return;
      }
      /* Outline hulls DO belong in the prepass, but only through their
         own ND variant — the shell has to reproduce its screen-space
         expansion or the stroke lands in the buffer at the wrong place,
         and it writes a camera-facing normal so a two-pixel sliver
         contributes no AO of its own (see toon.js OUTLINE_ND_FRAG).
         Leaving them out entirely is what let the far-field DOF erase
         every outline drawn against the sky. */
      if (o.userData.isOutlineHull === true) {
        const om = o.material;
        if (om && om.userData && om.userData.ndMaterial) {
          pushSwap(o, om);
          o.material = om.userData.ndMaterial;
        } else {
          pushSwap(o, undefined);
          o.visible = false;
        }
        return;
      }
      const m = o.material;
      if (!m || Array.isArray(m)) return;
      if (m.transparent === true && m.userData.prepass !== true) return;
      pushSwap(o, m);
      o.material = m.userData.ndMaterial || ndMaterial;
    });
  }

  function restoreSwap() {
    for (let i = 0; i < swapCount; i++) {
      const o = swapObjs[i];
      const m = swapMats[i];
      if (m === undefined) o.visible = true;
      else o.material = m;
      swapObjs[i] = null; swapMats[i] = null;
    }
    swapCount = 0;
  }

  /* ================================================================
     Frame
     ================================================================ */
  const clearBlack = new THREE.Color(0, 0, 0);
  /* Does the frame need a normal+depth buffer at all? */
  let needND = q.ssao !== false || q.dof !== false;
  /* HOW it is produced. false = one full-screen un-projection of the
     main pass's own depth texture (the default, and 547 draw calls
     cheaper); true = the old geometry prepass, kept as an A/B switch
     for `WALLY.debug.prepass(true)` and as a fallback for any context
     that cannot give us a depth texture. */
  let geoPrepass = false;
  let lastDt = 1 / 60;
  /* Non-finite watch. 0 = off; N = run postfx's probe every Nth frame.
     Debug only — each probe is a synchronous GPU readback. postfx §7. */
  let nanEvery = 0;
  let nanOnHit = null;
  let nanBusy = false;
  const nanLog = [];
  const api = {};

  function render() {
    const cam = ctx.camera;
    if (!cam) return;
    /* Is the drawing buffer still the shape of the canvas? See the
       viewport reconciler below — this is the backstop for a rotation
       or a fullscreen change that arrived without a usable event. */
    tickViewport();
    /* SANITISE dt BEFORE IT REACHES THE POST CHAIN.
       main.js seeds its clock after the boot loop, so the first
       requestAnimationFrame timestamp predates that call by however
       long the last boot stage took — on this machine, with the NPC
       stage running 8 s, ctx.elapsed was measured at -12.5 s and the
       matching ctx.dt was large and NEGATIVE.

       Everything downstream that integrates dt then runs backwards.
       postfx's grade easing is `damp(v, target, lambda, dt)`, i.e.
       lerp by 1 - exp(-lambda*dt); at dt = -12.5 that factor is
       -e^15, and one frame of it threw the grade uniforms to +-2.5e5
       (uExposure 247338, uSat -275170). The composite then produced a
       BLACK FRAME — every WALLY.debug.flyTo() screenshot came back
       pure black, with a perfectly good scene buffer behind it, for as
       long as it took the ease to crawl back from 1e5 (about ten
       seconds at lambda 1.2). camera.js already guards its own springs
       against exactly this; the post chain did not.

       This is the one place the post chain's dt is computed, so it is
       the one place to fix it. `lastDt` is now only ever a sane value.
       (postfx.render() re-clamps as well: it is a public entry point
       and must not trust its caller either.) */
    let dt = ctx.dt;
    dt = dt > 0 ? Math.min(dt, 0.05) : lastDt;
    lastDt = dt;
    renderer.info.reset();

    /* ---- 0. fit the cascades to this frame's camera ---- */
    csm.update(cam);

    /* ---- 1. the old geometry prepass, only if forced ---- */
    if (needND && geoPrepass) {
      renderer.shadowMap.needsUpdate = false;
      collectAndSwap();
      const bg = scene.background;
      scene.background = null;
      renderer.setRenderTarget(rtND);
      renderer.setClearColor(clearBlack, 0);
      renderer.autoClear = false;
      renderer.clear(true, true, false);
      renderer.render(scene, cam);
      renderer.autoClear = true;
      scene.background = bg;
      restoreSwap();
    }

    /* ---- 2 + 3. main forward pass (shadow maps render first) ---- */
    renderer.shadowMap.needsUpdate = true;
    renderer.setClearColor(api.clearColor, 1);
    renderer.setRenderTarget(rtScene);
    renderer.render(scene, cam);

    /* ---- 3b. normal + depth, un-projected from what we just drew ---- */
    if (needND && !geoPrepass) {
      if (!post.resolveND(rtScene, rtND, cam)) geoPrepass = true;
    }

    /* ---- 4..10. post ---- */
    post.render(rtScene, rtND, cam, dt);

    /* ---- 11. the non-finite watch, when it is armed ---- */
    /* nanBusy: the hit callback is allowed to re-render the frame with
       objects hidden, to bisect which material produced the value —
       so the watch must not re-enter itself when it does. */
    if (nanEvery > 0 && !nanBusy && (ctx.frame % nanEvery) === 0) {
      nanBusy = true;
      const p = post.probe(rtScene, rtND);
      if (p.any) {
        /* The callback runs INSIDE the offending frame, before
           anything animates on, which is the only moment a tool can
           still ask what was under that texel. Kept out of this file
           deliberately: raycasting the scene graph is not the render
           layer's business, but handing a tool the exact frame is. */
        let extra;
        if (nanOnHit) { try { extra = nanOnHit(p, cam); } catch (e) { extra = { err: String(e && e.message) }; } }
        if (nanLog.length < 64) {
          nanLog.push({ frame: ctx.frame, t: +ctx.elapsed.toFixed(2), ...p, extra });
        }
      }
      nanBusy = false;
    }

    renderer.setRenderTarget(null);
  }

  /* ================================================================
     THE VIEWPORT RECONCILER — the landscape hard edge.

     THE BUG. A user's sideways screenshot showed the world ending at a
     hard vertical line with dark blue beyond it. That is the drawing
     buffer keeping the shape it had before the rotation while the CSS
     box already has the new one: the canvas is stretched over a box it
     was not drawn for, and everything the frame was composed against —
     camera aspect, every post target, the vignette's own aspect — is
     fitted to the old rectangle.

     WHY IT HAPPENS. main.js drives the resize off ONE signal, the
     window's `resize` event, and reads innerWidth/innerHeight when it
     fires. Both halves of that are unreliable on a handheld, and
     ui/orient.js now pushes the game through exactly the sequence
     where they fail:

       * requestFullscreen() and screen.orientation.lock() land in the
         same activation, so the viewport changes twice in a few
         frames and some engines coalesce the events;
       * `orientationchange` fires BEFORE layout on several mobile
         engines, and a `resize` delivered alongside it reports the
         PREVIOUS orientation's innerWidth/innerHeight;
       * leaving fullscreen by a system gesture resizes without
         necessarily notifying the page at all;
       * iOS Safari has no element fullscreen, so the whole flip
         arrives as a rotation the page only learns about late.

     A missed or stale event is therefore not an edge case here, it is
     the normal path, and nothing downstream ever re-checks.

     THE FIX IS TO STOP TRUSTING EVENTS AND ASSERT AN INVARIANT:

         canvas.width  === round( canvas.clientWidth  * pixelRatio )
         canvas.height === round( canvas.clientHeight * pixelRatio )

     The canvas' own box is measured after layout and cannot be stale;
     innerWidth can be, and is. A ResizeObserver reports every change
     to that box (including ones no `resize` event accompanies), the
     fullscreen and orientation events poke it for the frames right
     after a transition, and a slow poll in the frame loop is the
     backstop for an engine that fires nothing at all. When the
     invariant breaks, this rebuilds the whole chain — renderer size,
     camera aspect, every post target, and every other module's
     resize hook — from the measured box.

     It is idempotent and cheap: when main.js has already got it right,
     the comparison matches and nothing happens.
     ================================================================ */
  const canvasEl = ctx.canvas || renderer.domElement;
  let appliedW = 0, appliedH = 0;
  let syncFrames = 0;          // frames of eager checking after an event
  let vpAuto = true;           // debug: turn the reconciler off to A/B it
  let pollPhase = 0;

  /* The drawing buffer cannot exceed what the context will allocate.
     A phone in landscape fullscreen at devicePixelRatio 3 is the case
     that finds this, and a render target that fails to allocate is
     black — the other way this bug reports itself. */
  const GL_LIMIT = (() => {
    try {
      const gl = renderer.getContext();
      return Math.min(
        gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096,
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096,
      );
    } catch (e) { return 4096; }   // conservative, and true of every ES3 device
  })();
  function maxPixelRatio(cssW, cssH) {
    return Math.max(0.5, Math.min(q.pixelRatio, GL_LIMIT / Math.max(cssW, cssH)));
  }

  /* The measured truth. Falls back to the window only when the canvas
     has no box at all (display:none, or a detached canvas). */
  function measure() {
    let w = canvasEl ? canvasEl.clientWidth : 0;
    let h = canvasEl ? canvasEl.clientHeight : 0;
    if (!w || !h) {
      const vv = typeof visualViewport !== 'undefined' ? visualViewport : null;
      w = Math.round((vv && vv.width) || window.innerWidth || 1);
      h = Math.round((vv && vv.height) || window.innerHeight || 1);
    }
    return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
  }

  function viewportState() {
    const [cw, ch] = measure();
    const pr = renderer.getPixelRatio();
    return {
      css: [cw, ch],
      buffer: canvasEl ? [canvasEl.width, canvasEl.height] : null,
      want: [Math.round(cw * pr), Math.round(ch * pr)],
      pixelRatio: pr,
      camAspect: ctx.camera ? +ctx.camera.aspect.toFixed(4) : null,
      sceneRT: [rtScene.width, rtScene.height],
      inSync: !!canvasEl
        && canvasEl.width === Math.round(cw * pr)
        && canvasEl.height === Math.round(ch * pr)
        && rtScene.width === canvasEl.width && rtScene.height === canvasEl.height,
    };
  }

  function syncViewport(force) {
    /* The ResizeObserver is installed during init(), so this can be
       reached before the api object is finished. */
    if (!canvasEl || typeof api.resize !== 'function') return false;
    const [cw, ch] = measure();
    const pr = maxPixelRatio(cw, ch);
    if (pr !== renderer.getPixelRatio()) renderer.setPixelRatio(pr);
    const wantW = Math.round(cw * pr);
    const wantH = Math.round(ch * pr);
    if (!force
      && cw === appliedW && ch === appliedH
      && canvasEl.width === wantW && canvasEl.height === wantH
      && rtScene.width === wantW && rtScene.height === wantH) return false;

    appliedW = cw; appliedH = ch;

    const cam = ctx.camera;
    if (cam && cam.isPerspectiveCamera) {
      const a = cw / ch;
      if (Math.abs(cam.aspect - a) > 1e-6) { cam.aspect = a; cam.updateProjectionMatrix(); }
    }
    renderer.setSize(cw, ch, false);
    api.resize(cw, ch);
    /* Everyone else's resize hook, exactly as main.js fans it out —
       the UI, the touch layer and the intro all size themselves off
       this and would otherwise stay fitted to the old rectangle. */
    const hs = ctx._handles || [];
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (h && h !== api && typeof h.resize === 'function') {
        try { h.resize(cw, ch); } catch (e) { /* one module must not block the rest */ }
      }
    }
    try { ctx.bus?.emit?.('render:viewport', { w: cw, h: ch, pixelRatio: pr }); } catch (e) {}
    return true;
  }

  /* Called from render(). Eager for a moment after any transition,
     then a slow poll — reading clientWidth forces layout, so it is not
     something to do sixty times a second forever. */
  function tickViewport() {
    if (!vpAuto) return;
    if (syncFrames > 0) { syncFrames--; syncViewport(false); return; }
    if ((++pollPhase & 31) === 0) syncViewport(false);
  }

  const bump = () => { if (vpAuto) syncFrames = 12; };
  const vpOff = [];
  function bindVP(target, type) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(type, bump);
    vpOff.push(() => target.removeEventListener(type, bump));
  }
  bindVP(window, 'resize');
  bindVP(window, 'orientationchange');
  bindVP(document, 'fullscreenchange');
  bindVP(document, 'webkitfullscreenchange');
  bindVP(typeof screen !== 'undefined' ? screen.orientation : null, 'change');
  bindVP(typeof visualViewport !== 'undefined' ? visualViewport : null, 'resize');

  let ro = null;
  if (typeof ResizeObserver === 'function' && canvasEl) {
    ro = new ResizeObserver(() => {
      if (!vpAuto) return;
      syncFrames = Math.max(syncFrames, 4);
      syncViewport(false);
    });
    try { ro.observe(canvasEl); } catch (e) { ro = null; }
  }

  /* ================================================================
     public API — ctx.render
     ================================================================ */
  Object.assign(api, {
    /* --- core --- */
    render,
    composer,
    post,
    csm,
    /* Off-screen silhouette / coverage masks. See silhouette.js for the
       measurement that motivates it and the exact call sequence.

         const rt  = ctx.render.silhouette.target('wally.shadow', 320);
         const cam = ctx.render.silhouette.makeCamera(1.06, 0.05, 7, LAYER);
         ctx.render.silhouette.aimSun(cam, centre, { outVP: shVP });
         ctx.render.silhouette.render(root, cam, rt);   // 0.06 ms

       `render` traverses ONLY the object you hand it, not the scene,
       which is the difference between 1.99 ms and 0.06 ms a frame. */
    silhouette,
    quality: q,
    targets: { scene: rtScene, normalDepth: rtND },
    clearColor: new THREE.Color().setHex(SKY.horizon, THREE.SRGBColorSpace),

    /* Prepass normals+linear depth, for anyone who wants them
       (water refraction masks, decals, silhouette effects). */
    get normalDepthTexture() { return rtND.texture; },
    get sceneTexture() { return rtScene.texture; },

    /* --- depth of field ---
       focus in metres, aperture 0..10 (5.6-equivalent gameplay is
       ~2.6, f/1.8 cinematic is ~7.5), farClamp caps background blur
       so the horizon stays readable (§2.4). */
    setDOF(focus, aperture, farClamp, farGain) { post.setDOF(focus, aperture, farClamp, farGain); },

    /* --- colour grade ---
       name: 'day' | 'golden' | 'dusk' | 'night' | 'interior' |
             'cinematic' | 'studio' | 'neutral'
       lambda > 0 eases into it (use ~1.2 for a time-of-day change). */
    setGrade(name, lambda) { post.setGrade(name, lambda); },
    grades: GRADES,

    setExposure(v) { post.params.exposure = v; },
    setSSAO(radius, strength) { post.setSSAO(radius, strength); },
    setBloom(threshold, strength) { post.setBloom(threshold, strength); },
    setGrain(amount) { post.setGrain(amount); },
    setVignette(amount) { post.setVignette(amount); },

    /* Put a post intermediate on screen instead of the frame:
       'ao' | 'nd' | 'depth' | 'bloom' | 'dof' | 'scene', null to
       restore. The only way to tell a pass that is off from a pass
       that is on and doing nothing. */
    setDebugBuffer(name) { post.setDebug(name); },

    /* --- quality --- */
    setQuality(nameOrTier) {
      const t = typeof nameOrTier === 'string' ? null : nameOrTier;
      const tier = t || null;
      if (tier) Object.assign(q, tier);
      renderer.setPixelRatio(q.pixelRatio);
      csm.setMapSize(q.shadowSize);
      csm.setFar(SHADOW_FAR[tierName(q.name)] ?? 110);
      post.params.ssao = q.ssao !== false;
      post.params.bloom = q.bloom !== false;
      post.params.dof = q.dof !== false;
      post.params.grain = q.grain !== false;
      needND = post.params.ssao || post.params.dof;
      api.resize(window.innerWidth, window.innerHeight);
      ctx.bus.emit('quality', q);
    },

    /* Toggle the whole post chain — useful when eyeballing raw
       material output. */
    setPost(on) {
      post.params.ssao = on && q.ssao !== false;
      post.params.bloom = on && q.bloom !== false;
      post.params.dof = on && q.dof !== false;
      post.params.grain = on && q.grain !== false;
      post.params.fxaa = on;
      needND = post.params.ssao || post.params.dof;
    },

    resize(w, h) {
      renderer.getDrawingBufferSize(dbs);
      W = Math.max(1, Math.round(dbs.x));
      H = Math.max(1, Math.round(dbs.y));
      composer.resize(W, H);
      post.resize(W, H);
    },

    /* Force the whole chain back into agreement with the canvas' real
       box. See syncViewport() below. Returns true if anything moved. */
    syncViewport(force) { return syncViewport(force); },
    viewportState,

    dispose() {
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      for (const f of vpOff) f();
      vpOff.length = 0;
      composer.dispose();
      post.dispose();
      csm.dispose();
      silhouette.dispose();
      ndMaterial.dispose();
    },
  });

  /* main.js calls resize() after boot, but the composer needs correct
     sizes for the very first frame too. */
  api.resize(W, H);

  /* ---------------- debug hooks ---------------- */
  const dbg = (window.WALLY && window.WALLY.debug) || {};
  dbg.grade = (n, l) => api.setGrade(n, l);
  dbg.dof = (f, a, c, g) => api.setDOF(f, a, c, g);
  dbg.post = (on) => api.setPost(on !== false);
  dbg.exposure = (v) => api.setExposure(v);
  dbg.buffer = (n) => api.setDebugBuffer(n || null);
  /* A/B the two ways of filling main.nd. See `geoPrepass` above. */
  dbg.prepass = (on) => { geoPrepass = !!on; return { geoPrepass, needND }; };
  /* THE BLACK-SQUARE HUNT. `nanWatch(1)` probes every buffer in the
     post chain every frame for NaN/Inf and records the first 64 bad
     frames; `nanProbe()` answers for this frame only; `nanSelfTest()`
     proves the probe can see a NaN on this driver at all. postfx §7. */
  dbg.nanWatch = (every, onHit) => {
    nanEvery = Math.max(0, every | 0);
    nanOnHit = typeof onHit === 'function' ? onHit : null;
    nanLog.length = 0;
    return nanEvery;
  };
  dbg.nanLog = () => nanLog.slice();
  dbg.nanProbe = () => post.probe(rtScene, rtND);
  dbg.nanSelfTest = (mode) => post.probeSelfTest(mode);
  /* THE LANDSCAPE CHECK. `viewport()` is the whole sizing chain in one
     object; `inSync:false` is the hard-edged frame the user shot. */
  dbg.viewport = () => viewportState();
  dbg.syncViewport = (force) => syncViewport(force !== false);
  /* Off, the frame goes back to trusting main.js's single resize
     event — which is the state the landscape bug was reported in. */
  dbg.viewportAuto = (on) => { vpAuto = on !== false; return vpAuto; };
  dbg.sun = (x, y, z) => csm.setSun(new THREE.Vector3(x, y, z).normalize());
  dbg.renderInfo = () => ({
    calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    programs: renderer.info.programs?.length ?? 0,
    quality: q.name,
    cascades: csm.cfg.cascades,
  });
  if (window.WALLY) window.WALLY.debug = dbg;

  return api;
}
