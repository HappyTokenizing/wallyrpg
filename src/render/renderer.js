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
  /* The first frame renders at the tier's `pixelRatio`, which is 1 on
     every tier — i.e. exactly the frame this project has always
     measured. Anything above that is climbed to, later, by the
     governor below, and only on evidence from this device. */
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
  /* MSAA ON THE MAIN PASS. `msaa` has been in every quality tier since
     the tiers were written and nothing read it, so the game shipped
     with FXAA as its only anti-aliasing — a post filter that cannot
     recover an edge narrower than a pixel, which is most of what the
     detail pass added (0.05 m is a third of a pixel at 30 m). three
     resolves the DEPTH attachment as well as the colour when
     `resolveDepthBuffer` is on, so the depth TEXTURE the ND pass
     un-projects still arrives single-sampled and correct — that is the
     thing to check first if this is ever suspected. `?msaa=N` forces
     it on any tier; see pickQuality. */
  const rtScene = composer.target('main.scene', 1, {
    depthBuffer: true, depthTexture: true, samples: Math.max(0, q.msaa | 0),
  });
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
    /* ...and is the frame sharp as it can afford to be? See THE
       SHARPNESS GOVERNOR. Runs before the draw so a step taken this
       frame is the size this frame is drawn at. */
    governorTick();
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

  /* ================================================================
     THE SHARPNESS GOVERNOR.

     THE BUG. `maxPixelRatio` was `min(q.pixelRatio, GL_LIMIT/…)`, and
     q.pixelRatio is 1 on every tier, so this function could only ever
     clamp DOWNWARD from 1 and its own guard comment above — "a phone
     at dpr 3 is the case that finds this" — could never bind on
     anything. MEASURED on a 390x844 mobile context before the change:
     renderer.getPixelRatio() was 1 at devicePixelRatio 1, 2 AND 3,
     backing store 390x844 in all three. On a 1170x2532 iPhone that is
     0.33 Mpx drawn and scaled 3x by the compositor, which is the whole
     of why the game looks soft on a phone. It was never a performance
     decision; it was a desktop conclusion written into a constant.

     WHY THIS IS A GOVERNOR AND NOT A BIGGER CONSTANT. The cost shape
     is known — at 390x844 the frame is submission-bound, and GPU time
     measured FLAT across dpr 1/2/3 — but it was measured on an M1 Max
     and says nothing whatever about an iPhone 12 or a mid-range
     Android, where the raster fraction of that frame is a different
     size. A fixed 2 would be spending a budget nobody here has ever
     seen. So the device measures itself:

       · the ladder is [1, 1.5, 2]. IT STARTS AT 1 — the exact frame
         that shipped before this, on hardware nobody has profiled;
       · one notch per clean window, so the worst case this can ever
         leave a player in is the frame they already had;
       · the signal is MISSED 60 fps, not "headroom". Under vsync a
         frame time is quantised to the display grid and headroom is
         INVISIBLE — every healthy frame reads 16.7 whether it had 2 ms
         of work or 16. What the grid does show is a frame the
         compositor could not service. So the governor does not try to
         measure what it cannot: it takes one step, watches, and locks
         the ladder permanently below the first notch that misses.
         That is a search, and it converges in two windows;
       · a demotion is PERMANENT for the session. An oscillating
         governor is worse than a slightly soft one, and the state it
         locks into is the state it booted in.

     `late` is a frame over GOV_LATE_MS = 20 ms — one missed vsync on a
     60 Hz panel (16.7 -> 33.3) with a wide margin either side. On a
     120 Hz panel a fall from 120 to 60 is deliberately NOT late: 60 is
     the promise in BUILD_BRIEF, and a governor that defends 120 would
     refuse to sharpen a phone that is doing fine. Anything over
     GOV_IGNORE_MS = 250 ms is not a sample at all — that is a
     backgrounded tab or a one-shot boot stall, and demoting the player
     for switching apps would be its own bug.

     THE A/B. `WALLY.debug.governor(false)` compiles it out live and
     `WALLY.debug.pixelRatio(1)` pins the old rule, both on ONE page
     load — the shipping rule and the rule it replaced, side by side,
     which is the strong form this project asks for. tools/mobilebugs
     PR-1..7 drives exactly that.
     ================================================================ */
  const PR_LADDER = [1, 1.5, 2];
  const GOV_WINDOW = 60;     // frames per decision window (~1 s at 60 fps)
  const GOV_SETTLE = 24;     // frames discarded after a size change
  const GOV_BOOT = 120;      // ...and after boot: shader compiles, streaming
  const GOV_LATE_MS = 20;    // a frame the 60 Hz compositor could not service
  const GOV_IGNORE_MS = 250; // not a sample: tab throttle, boot stall
  const GOV_DROP_LATE = 3;   // >= 5 % of a window; one hitch must not demote

  /* A shot run must be reproducible between builds, so the governor is
     off under ?shot unless it is asked for explicitly. */
  let govOn = !ctx.flags?.shot;
  try {
    const gp = new URLSearchParams(location.search).get('govern');
    if (gp != null) govOn = !/^(0|off|false|no)$/i.test(gp);
  } catch (e) {}
  let govStep = 0;                       // index into PR_LADDER
  let govCap = PR_LADDER.length - 1;     // learned ceiling, lowered on failure
  let govSettle = GOV_BOOT;
  let govN = 0, govLate = 0, govLast = 0, govIgnored = 0, govFrame = -1;
  const govLog = [];

  /* ================================================================
     ONE CLAMP, AND THE PIN IS STORED THROUGH IT.

     THE BUG. There were two. The frame loop's clamp floored the ratio
     at 0.5 and ceilinged it at GL_LIMIT / longest side; the debug pin
     `WALLY.debug.pixelRatio(v)` floored at 0.25 and ceilinged at 8,
     stored THAT in prOverride, and only then handed it to the first
     clamp on its way to the renderer. So the number a measurement rig
     set, the number governorState() reported back, and the number the
     frame was drawn at were three things.

     WHAT THAT COSTS. `pixelRatio(0.25)` and `pixelRatio(0.5)` are the
     SAME CONDITION — both draw at 0.5 — while the pin, the log and
     every table built off `governorState().override` say 0.25 and 0.5.
     A two-arm A/B run at those ratios measures one arm twice and
     reports the difference between two samples of the same frame as a
     result. This project has already voided an experiment for exactly
     that shape of mistake (the "becalmed" wind arm that measured
     windier than the drifting one), and the fix is the same both
     times: there must be nowhere left to set the value that does not
     go through the clamp.

     SO: PR_MIN / PR_MAX are the only bounds that exist, clampPR is the
     only function that applies them, and prOverride can only be
     assigned by setPin(), which stores what will actually be drawn.
     `viewportState()` publishes the request beside it — `prPinWant`,
     `prPin`, `prPinClamped` — so an arm that has collapsed into
     another one says so in the same object a rig already reads. */
  const PR_MIN = 0.5;                    // below this the frame is unreadable
  const PR_MAX = 8;                      // and above it nothing can allocate
  const clampPR = (pr, cssW, cssH) => Math.max(PR_MIN, Math.min(
    Number.isFinite(+pr) ? +pr : 1, PR_MAX, GL_LIMIT / Math.max(1, Math.max(cssW, cssH))));

  let prOverride = null;                 // debug / measurement pin, ALREADY CLAMPED
  let prOverrideWant = null;             // ...and what was asked for

  /* The one door into the pin. null / false hands the ratio back to
     the governor. Returns the clamped value that will be drawn. */
  function setPin(v) {
    if (v == null || v === false) { prOverride = null; prOverrideWant = null; return null; }
    const [cw, ch] = measure();
    prOverrideWant = Number.isFinite(+v) ? +v : 1;
    prOverride = clampPR(prOverrideWant, cw, ch);
    return prOverride;
  }

  /* The ceiling for THIS viewport. A megapixel budget, not a dpr
     constant: it is orientation-invariant and it self-limits on a big
     panel, which is what makes it safe on hardware nobody measured.
     See the pixel-ratio block at the top of contracts.js. */
  function pixelRatioCeiling(cssW, cssH) {
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    const tierMax = Number.isFinite(q.pixelRatioMax) ? q.pixelRatioMax : (q.pixelRatio || 1);
    const budgetMpx = Number.isFinite(q.pixelBudget) ? q.pixelBudget : 1.6;
    const byBudget = Math.sqrt((budgetMpx * 1e6) / Math.max(1, cssW * cssH));
    return clampPR(Math.max(1, Math.min(tierMax, dpr, byBudget)), cssW, cssH);
  }
  /* What the ladder asks for at step `i`, after the ceiling. */
  const stepRatio = (i, cssW, cssH) =>
    Math.min(PR_LADDER[Math.max(0, Math.min(PR_LADDER.length - 1, i))], pixelRatioCeiling(cssW, cssH));

  function maxPixelRatio(cssW, cssH) {
    /* prOverride was clamped by setPin() against the viewport it was
       set in; re-clamp here because the viewport can have changed
       under it since (a rotation, a fullscreen flip). Same function,
       so it is idempotent when nothing moved. */
    if (prOverride != null) return clampPR(prOverride, cssW, cssH);
    return clampPR(stepRatio(govStep, cssW, cssH), cssW, cssH);
  }

  function governorTick() {
    /* ONE SAMPLE PER FRAME, NOT PER render() CALL. render() is called
       more than once per rAF by more than one thing in tools/ — the
       profiler's stress mode re-renders the same frame to saturate the
       GPU clock, and the black-square hunt re-renders to bisect a
       material. Each of those extra calls is microseconds apart, and
       counting them would fill a "clean window" with samples that are
       not frames at all, then lift the ratio on the strength of it.
       ctx.frame is main.js's own counter and is the only thing here
       that means "a new frame". */
    if (ctx.frame === govFrame) return;
    govFrame = ctx.frame;
    const now = performance.now();
    const d = govLast ? now - govLast : 0;
    govLast = now;
    if (!govOn || prOverride != null) return;
    if (d <= 0) return;
    if (d > GOV_IGNORE_MS) { govIgnored++; return; }
    if (govSettle > 0) { govSettle--; return; }
    govN++;
    if (d > GOV_LATE_MS) govLate++;
    if (govN < GOV_WINDOW) return;

    const late = govLate;
    govN = 0; govLate = 0;

    if (late >= GOV_DROP_LATE && govStep > 0) {
      /* This notch missed 60. Never try it again this session. */
      govCap = govStep - 1;
      setStep(govCap, `drop: ${late}/${GOV_WINDOW} frames > ${GOV_LATE_MS} ms`);
    } else if (late === 0 && govStep < govCap) {
      const [cw, ch] = measure();
      /* Already at the viewport's ceiling — a further notch would
         change nothing, so stop rather than log a lift that isn't one. */
      if (stepRatio(govStep + 1, cw, ch) > stepRatio(govStep, cw, ch) + 1e-6) {
        setStep(govStep + 1, 'lift: clean window');
      } else {
        govCap = govStep;
      }
    }
  }

  function setStep(i, why) {
    const prev = govStep;
    govStep = Math.max(0, Math.min(PR_LADDER.length - 1, i));
    govSettle = GOV_SETTLE;
    const moved = syncViewport(false);
    if (govLog.length < 32) {
      govLog.push({ frame: ctx.frame, from: PR_LADDER[prev], to: PR_LADDER[govStep],
        pr: +renderer.getPixelRatio().toFixed(3), moved, why });
    }
    return moved;
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

  /* ================================================================
     WHAT THE BACKING STORE IS ACTUALLY SIZED TO — AND THE HEALTH FLAG
     THAT GOT IT WRONG THE MOMENT THE RATIO STOPPED BEING 1.

     three.js allocates the drawing buffer with
     `canvas.width = Math.FLOOR(cssW * pixelRatio)`
     (WebGLRenderer.setSize), and every post target follows it through
     getDrawingBufferSize(), which floors too. `inSync` and
     syncViewport's early-out both computed the expected size with
     Math.ROUND. While `pixelRatio` was 1 on every tier those two
     agreed for every viewport that exists and the mistake could not
     show. The megapixel budget made the ratio irrational, and floor
     and round now agree only when the product's fractional part
     happens to land under a half. MEASURED — headless Chrome, ANGLE
     Metal, M1 Max, tier high, the governor taking its own notch
     (tools/_k30-insync.mjs):

       1600x900  pr 1.2638  buffer 2022x1137  round 2022x1137  agreed
       1440x900  pr 1.3322  buffer 1918x1198  round 1918x1199  LIED
       1366x768  pr 1.4807  buffer 2022x1137  round 2023x1137  LIED
       1280x800  pr 1.4987  buffer 1918x1198  round 1918x1199  LIED
        390x844  pr 1.5     buffer  585x1266  round  585x1266  agreed

     Three of five shapes reported DESYNC on a frame that was correct
     in every respect — and this is the flag anyone debugging a
     resolution problem reaches for first, in the round that just made
     the ratio dynamic. The two that agreed did so by luck (1600x900's
     fractional part is 0.43), not by law.

     AND IT WAS NEVER ONLY A FLAG. syncViewport's early-out compared
     the same rounded number against the same floored canvas, so on
     those three shapes it could NEVER match: every poll — once per 32
     frames forever, and twelve frames running after any resize event
     — re-ran renderer.setSize, api.resize, the composer's whole
     target pool and every other module's resize hook, for a viewport
     that had not moved. `resyncs` counts the times syncViewport did
     work, so that is a number rather than an argument.

     THE A/B, ON ONE PAGE LOAD: `WALLY.debug.sizeRule('round')` puts
     the rule this replaced back into BOTH call sites and
     `sizeRule('floor')` returns the shipping one — the module-switch
     form contracts.js asks for, not a quoted before-number.
     tools/mobilebugs.mjs VP-1..VP-4 drives it.
     ================================================================ */
  let sizeRule = 'floor';        // 'floor' ships; 'round' is the rule it replaced
  let resyncs = 0;               // times syncViewport actually rebuilt the chain
  /* exactly what WebGLRenderer.setSize does, from the MEASURED css box
     rather than from the renderer's own stored one — reading it back
     off the renderer would agree with itself and could never see the
     desync this flag exists to catch. */
  const bufferPx = (css, pr) => (sizeRule === 'round' ? Math.round(css * pr) : Math.floor(css * pr));

  function viewportState() {
    const [cw, ch] = measure();
    const pr = renderer.getPixelRatio();
    return {
      css: [cw, ch],
      buffer: canvasEl ? [canvasEl.width, canvasEl.height] : null,
      want: [bufferPx(cw, pr), bufferPx(ch, pr)],
      /* THE RESIDUAL, WHICH IS REAL AND IS NOT A FAULT, so it gets its
         own name instead of being folded into a boolean. Flooring
         leaves up to one device pixel at the right and bottom edges
         covered by stretching rather than by a texel of its own. It is
         inherent to three's sizing and always under 1 CSS px; it is
         also the only thing `inSync:false` could honestly have meant
         on those three shapes. */
      slackCss: (canvasEl && pr > 0)
        ? [+(cw - canvasEl.width / pr).toFixed(3), +(ch - canvasEl.height / pr).toFixed(3)]
        : null,
      sizeRule,
      resyncs,
      pixelRatio: pr,
      /* what the tier would ALLOW here, vs what the ladder has earned */
      prCeiling: +pixelRatioCeiling(cw, ch).toFixed(3),
      /* THE PIN, AS REQUESTED AND AS DRAWN. Two arms of an A/B whose
         `prPin` matches are the same condition however different
         their `prPinWant` looks. */
      prPinWant: prOverrideWant,
      prPin: prOverride,
      prPinClamped: prOverrideWant != null && Math.abs(prOverrideWant - prOverride) > 1e-6,
      prMin: PR_MIN, prMax: PR_MAX,
      prStep: PR_LADDER[govStep],
      prBudgetMpx: Number.isFinite(q.pixelBudget) ? q.pixelBudget : null,
      mpx: canvasEl ? +((canvasEl.width * canvasEl.height) / 1e6).toFixed(3) : null,
      /* THE TARGET'S OWN COUNT, not the tier's wish. See dbg.msaa. */
      samples: rtScene.samples | 0,
      camAspect: ctx.camera ? +ctx.camera.aspect.toFixed(4) : null,
      sceneRT: [rtScene.width, rtScene.height],
      /* TRUE MEANS: the buffer is the surface. The canvas is sized to
         the box the browser is actually laying out, at the ratio the
         renderer is actually using, and the scene target the whole
         post chain runs at is that same canvas. */
      inSync: !!canvasEl
        && canvasEl.width === bufferPx(cw, pr)
        && canvasEl.height === bufferPx(ch, pr)
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
    /* SAME RULE AS setSize, OR THIS NEVER EARLY-OUTS. See the block
       above viewportState(). */
    const wantW = bufferPx(cw, pr);
    const wantH = bufferPx(ch, pr);
    if (!force
      && cw === appliedW && ch === appliedH
      && canvasEl.width === wantW && canvasEl.height === wantH
      && rtScene.width === wantW && rtScene.height === wantH) return false;

    appliedW = cw; appliedH = ch;
    resyncs++;

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
      csm.setMapSize(q.shadowSize);
      csm.setFar(SHADOW_FAR[tierName(q.name)] ?? 110);
      post.params.ssao = q.ssao !== false;
      post.params.bloom = q.bloom !== false;
      post.params.dof = q.dof !== false;
      post.params.grain = q.grain !== false;
      needND = post.params.ssao || post.params.dof;
      /* The new tier carries its own pixelRatioMax and pixelBudget, so
         the ladder restarts from the bottom and re-earns its way up on
         this tier's evidence rather than inheriting the last one's. */
      govStep = 0; govCap = PR_LADDER.length - 1;
      govSettle = GOV_SETTLE; govN = 0; govLate = 0;
      syncViewport(true);
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
  /* THE CONTROL FOR ALL OF THE ABOVE. `finiteGuard(false)` compiles the
     firewall out of bloomPreMat and compositeMat, which puts the frame
     back exactly where the user's report came from: the sky's stray
     NaN texel reaches the bloom pyramid and arrives on screen as a
     black block. `tools/blacksquares.mjs --noguard` asserts it comes
     back; the plain gate asserts it does not. A guard nobody can turn
     off is a guard nobody can prove is doing anything. */
  dbg.finiteGuard = (on) => post.setFiniteGuard(on !== false);
  /* THE LANDSCAPE CHECK. `viewport()` is the whole sizing chain in one
     object; `inSync:false` is the hard-edged frame the user shot. */
  dbg.viewport = () => viewportState();
  dbg.syncViewport = (force) => syncViewport(force !== false);
  /* THE SIZING-RULE SWITCH — the shipping rule and the rule it
     replaced, side by side on one page load. 'round' is what `inSync`
     and syncViewport's early-out used to compare against; 'floor' is
     what three.js actually allocates. Returns the rule now in force. */
  dbg.sizeRule = (r) => {
    if (r === 'round' || r === 'floor') { sizeRule = r; syncViewport(true); }
    return sizeRule;
  };
  /* ---- MSAA, SWITCHED LIVE, SO THE TRADE CAN BE TAKEN ON ONE LOAD ----
     `msaa` is baked into the scene target at construction, so the only
     way to A/B it used to be `?msaa=N` and one page load per value —
     and a page load changes the streamed foliage, the NPC positions
     and the wind phase along with the setting, which is exactly the
     confound that makes an edge-width difference unreadable. `samples`
     is a plain field on WebGLRenderTarget and three re-creates the
     framebuffer from it after dispose(); rtScene.texture survives as
     the same object, so every post uniform pointing at it stays
     valid. That makes msaa a sibling of pixelRatio(v): both notches
     of the same trade, driven on one page load, same world, same
     clock. Returns what the target actually got — the driver clamps
     to MAX_SAMPLES, and a request that was clamped must not be
     reported as the number that was asked for. */
  dbg.msaa = (n) => {
    const want = Math.max(0, Math.min(8, n | 0));
    if (want !== (rtScene.samples | 0)) {
      rtScene.samples = want;
      rtScene.dispose();          // three rebuilds the FBO at the new count
      q.msaa = want;              // so ENVSTATE/viewport() cannot disagree
    }
    let maxS = 0;
    try { const g = renderer.getContext(); maxS = g.getParameter(g.MAX_SAMPLES) | 0; } catch (e) {}
    return { want, samples: rtScene.samples | 0, maxSamples: maxS };
  };
  /* ---- THE SHARPNESS GOVERNOR, and its A/B ----
     `governor(false)` stops it dead where it stands; `pixelRatio(v)`
     pins a ratio through the shipped resize path (v = 1 is the rule
     this replaced, exactly); `pixelRatio(null)` hands it back. Both on
     one page load, which is what makes this a revert check and not a
     quoted before-number. `governorState()` is what it has decided and
     why. */
  dbg.governor = (on) => {
    govOn = on !== false;
    if (govOn) { govSettle = GOV_SETTLE; govN = 0; govLate = 0; govLast = 0; }
    return govOn;
  };
  /* Returns the ratio the frame is ACTUALLY drawn at — which is not
     always the one asked for, and a rig comparing two arms must
     compare these and not its own inputs. viewportState() carries
     prPinWant / prPin / prPinClamped for the same reason. */
  dbg.pixelRatio = (v) => {
    setPin(v);
    syncViewport(true);
    return renderer.getPixelRatio();
  };
  dbg.governorState = () => ({
    on: govOn, override: prOverride, overrideWant: prOverrideWant,
    overrideClamped: prOverrideWant != null && Math.abs(prOverrideWant - prOverride) > 1e-6,
    prMin: PR_MIN, prMax: PR_MAX,
    step: govStep, ladder: PR_LADDER.slice(), cap: govCap,
    pixelRatio: renderer.getPixelRatio(),
    window: GOV_WINDOW, lateMs: GOV_LATE_MS, dropLate: GOV_DROP_LATE,
    inWindow: govN, lateInWindow: govLate, settle: govSettle, ignored: govIgnored,
    tier: q.name, pixelRatioMax: q.pixelRatioMax, pixelBudget: q.pixelBudget,
    log: govLog.slice(),
  });
  /* Force a decision now instead of waiting a real second. THE POINT
     OF THIS HOOK IS THAT IT TAKES THE SAME DECISION governorTick()
     TAKES — it just does not have to sit through 60 frames to see it —
     so a lift here obeys the learned cap exactly as the frame loop
     does. It first shipped without that guard, and tools/mobilebugs
     PR-15 caught it climbing back over a notch that had already
     failed: an instrument that reported something other than the thing
     it was pointed at, which is the one thing this project keeps
     paying for. `force` is the deliberate escape hatch, and it says so
     in the log. */
  dbg.governorStep = (dir, force) => {
    const before = renderer.getPixelRatio();
    if (dir < 0) { if (govStep > 0) { govCap = govStep - 1; setStep(govCap, 'forced drop'); } }
    else if (force) setStep(govStep + 1, 'forced lift (past cap)');
    else if (govStep < govCap) setStep(govStep + 1, 'forced lift');
    return { before, after: renderer.getPixelRatio(), step: govStep, cap: govCap,
      capped: !force && govStep >= govCap };
  };
  /* Off, the frame goes back to trusting main.js's single resize
     event — which is the state the landscape bug was reported in. */
  dbg.viewportAuto = (on) => { vpAuto = on !== false; return vpAuto; };
  dbg.sun = (x, y, z) => csm.setSun(new THREE.Vector3(x, y, z).normalize());
  /* ---- THE FAR CASCADE'S CADENCE, AND ITS A/B ----
     `shadowCadence(1)` is the rule this replaced — every cascade
     re-rendered every frame — and `shadowCadence(3)` is what ships;
     both on one page load, same world, same clock, which is the
     module-switch form contracts.js asks for rather than a quoted
     before-number. `shadowStats(true)` reads and zeroes the counters,
     so a window is `stats(true)` at the start, N frames, `stats(true)`
     at the end. Counts, not milliseconds: renders and skips are
     load-independent and the box is shared. See csm.js. */
  dbg.shadowCadence = (n) => csm.setFarCadence(n);
  dbg.shadowStats = (reset) => csm.stats(reset === true);
  dbg.renderInfo = () => ({
    calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    programs: renderer.info.programs?.length ?? 0,
    quality: q.name,
    cascades: csm.cfg.cascades,
    farCadence: csm.cfg.farCadence,
  });
  if (window.WALLY) window.WALLY.debug = dbg;

  return api;
}
