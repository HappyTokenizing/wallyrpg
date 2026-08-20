/* ============================================================
   ripples.js — the ripple / wake field.

   Owned by the water agent. Not a module in the boot order: water.js
   creates one of these and hands the texture to the ocean shader.

   WHAT IT IS
   A small orthographic render target that follows the player, holding
   everything transient that happens ON the surface:

       R  foam            hard-edged, thresholded by the ocean shader
       G  crest height    positive lobe of the surface displacement
       B  trough height   negative lobe

   The ocean's vertex shader reads G-B as a displacement and the
   fragment reads R as foam. One texture, one instanced draw call.

   WHY IT IS REDRAWN RATHER THAN ACCUMULATED
   The obvious build is a ping-pong pair with a decay blit and a
   reprojection offset as the region scrolls. That costs two extra
   fullscreen passes, smears every ring through a bilinear tap per
   frame, and makes the whole field resolution-dependent. Every ripple
   here is a closed-form function of its own age, so the target can
   simply be cleared and every live ripple re-drawn from world
   coordinates. Rings stay pixel-crisp for their whole life, the region
   can jump anywhere with no reprojection, and the cost is one clear
   plus one instanced draw of N quads.

   ART_DIRECTION §5.4: the foam this feeds is OPAQUE and HARD-EDGED.
   Nothing in here produces a soft alpha gradient; the profiles are
   plateaus with a two-texel roll-off for antialiasing and no more.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { clamp } from '../core/contracts.js';

export const RIPPLE_KIND = { RING: 0, BLOB: 1, WAKE: 2 };

const MAX_RIPPLES = 224;

/* Per-quality field resolution and coverage. The span is deliberately
   modest — this is the "near the player" detail layer; anything that
   has to read from 300 m away is in the ocean shader itself. */
const FIELD = {
  low:   { size: 256, span: 96 },
  med:   { size: 384, span: 112 },
  high:  { size: 512, span: 128 },
  ultra: { size: 512, span: 128 },
};

export function createRipples(ctx) {
  const THREE_ = ctx.THREE || THREE;
  const qname = (ctx.quality?.name || 'high').replace(/\(.*\)/, '');
  const cfg = FIELD[qname] || FIELD.high;

  const rt = new THREE_.WebGLRenderTarget(cfg.size, cfg.size, {
    format: THREE_.RGBAFormat,
    type: THREE_.UnsignedByteType,
    minFilter: THREE_.LinearFilter,
    magFilter: THREE_.LinearFilter,
    wrapS: THREE_.ClampToEdgeWrapping,
    wrapT: THREE_.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = 'water.ripples';

  const scene = new THREE_.Scene();
  const cam = new THREE_.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /* rect = (centreX, centreZ, 1/span, span) — the ocean shader gets
     this same vec4 so both sides agree about where the field is. */
  const rect = new THREE_.Vector4(0, 0, 1 / cfg.span, cfg.span);

  /* ------------------------------------------------------------
     Instance buffers. Fixed capacity, filled from the live pool
     every frame; instanceCount does the rest.
     ------------------------------------------------------------ */
  const aCenter = new THREE_.InstancedBufferAttribute(new Float32Array(MAX_RIPPLES * 2), 2);
  const aParams = new THREE_.InstancedBufferAttribute(new Float32Array(MAX_RIPPLES * 4), 4);
  const aShape  = new THREE_.InstancedBufferAttribute(new Float32Array(MAX_RIPPLES * 4), 4);
  aCenter.setUsage(THREE_.DynamicDrawUsage);
  aParams.setUsage(THREE_.DynamicDrawUsage);
  aShape.setUsage(THREE_.DynamicDrawUsage);

  const geo = new THREE_.InstancedBufferGeometry();
  const quad = new THREE_.PlaneGeometry(2, 2);
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setIndex(quad.getIndex());
  geo.setAttribute('aCenter', aCenter);
  geo.setAttribute('aParams', aParams);
  geo.setAttribute('aShape', aShape);
  geo.instanceCount = 0;
  quad.dispose();

  const mat = new THREE_.ShaderMaterial({
    name: 'water.ripple.splat',
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE_.CustomBlending,
    blendEquation: THREE_.AddEquation,
    blendSrc: THREE_.OneFactor,
    blendDst: THREE_.OneFactor,
    uniforms: {
      uRect: { value: rect },
    },
    vertexShader: /* glsl */`
      attribute vec2 aCenter;
      attribute vec4 aParams;   // radius, band width, strength, kind
      attribute vec4 aShape;    // dirX, dirZ, elongation, seed
      uniform vec4 uRect;

      varying vec2  vLocal;
      varying vec4  vP;
      varying vec4  vS;

      void main() {
        /* The quad has to contain the whole profile: the ring's outer
           edge plus its wobble, or a wake blob's long axis. */
        float ext = ( aParams.x + aParams.y * 1.6 ) * ( 1.0 + 0.22 )
                  * max( 1.0, aShape.z ) + 0.12;
        vLocal = position.xy * ext;
        vP = aParams;
        vS = aShape;
        vec2 wp = aCenter + vLocal;
        vec2 uv = ( wp - uRect.xy ) * uRect.z + 0.5;
        gl_Position = vec4( uv * 2.0 - 1.0, 0.0, 1.0 );
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2  vLocal;
      varying vec4  vP;
      varying vec4  vS;

      float hash11( float p ) {
        p = fract( p * 0.1031 );
        p *= p + 33.33;
        return fract( p * ( p + p ) );
      }

      void main() {
        float r  = vP.x;
        float w  = max( vP.y, 0.02 );
        float st = vP.z;
        float kind = vP.w;
        vec2  dir = vS.xy;
        float elong = max( vS.z, 1.0 );
        float seed = vS.w;

        /* Local frame: x along the object's heading for wake shapes,
           radial for rings. */
        vec2 q = vec2( dot( vLocal, dir ), dot( vLocal, vec2( -dir.y, dir.x ) ) );
        float ang = atan( q.y, q.x );

        /* Foam is never a clean circle. A two-lobe angular wobble is
           the cheapest thing that reads as broken-up surf and it also
           hides the field's texel grid at the threshold. */
        float wob = 1.0
          + 0.115 * sin( ang * 5.0 + seed * 6.2831 )
          + 0.065 * sin( ang * 11.0 - seed * 12.566 );

        float foam = 0.0;
        float up = 0.0;
        float down = 0.0;

        if ( kind < 0.5 ) {
          /* ---- expanding ring ---- */
          float d = length( q ) / wob;
          float s = ( d - r ) / w;                 // -1 .. 1 across the band
          float band = 1.0 - smoothstep( 0.62, 0.92, abs( s ) );
          foam = band * st;
          up   = band * st * 0.9;
          /* the water inside an expanding ring is pulled down */
          down = st * 0.45 * ( 1.0 - smoothstep( r * 0.15, r * 0.95, d ) );
        } else if ( kind < 1.5 ) {
          /* ---- splash / impact blob: a filled disc that hollows ---- */
          float d = length( q ) / wob;
          float fill = 1.0 - smoothstep( r * 0.86, r, d );
          foam = fill * st;
          up   = fill * st * 1.15;
        } else {
          /* ---- wake blob: an ellipse dragged along the heading ---- */
          vec2 e = vec2( q.x / elong, q.y );
          float d = length( e ) / wob;
          float fill = 1.0 - smoothstep( r * 0.72, r, d );
          foam = fill * st;
          up   = fill * st * 0.75;
        }

        gl_FragColor = vec4( foam, up, down, 1.0 );
      }
    `,
  });

  const mesh = new THREE_.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'water.ripples';
  scene.add(mesh);

  /* ------------------------------------------------------------
     The live pool. Structure-of-arrays so the per-frame refill is a
     straight copy with no allocation.
     ------------------------------------------------------------ */
  const P = {
    x: new Float32Array(MAX_RIPPLES),
    z: new Float32Array(MAX_RIPPLES),
    r0: new Float32Array(MAX_RIPPLES),
    r1: new Float32Array(MAX_RIPPLES),
    w0: new Float32Array(MAX_RIPPLES),
    w1: new Float32Array(MAX_RIPPLES),
    str: new Float32Array(MAX_RIPPLES),
    age: new Float32Array(MAX_RIPPLES),
    life: new Float32Array(MAX_RIPPLES),
    kind: new Float32Array(MAX_RIPPLES),
    dx: new Float32Array(MAX_RIPPLES),
    dz: new Float32Array(MAX_RIPPLES),
    el: new Float32Array(MAX_RIPPLES),
    seed: new Float32Array(MAX_RIPPLES),
    vx: new Float32Array(MAX_RIPPLES),
    vz: new Float32Array(MAX_RIPPLES),
  };
  let count = 0;

  function spawn(o) {
    let i = count;
    if (count >= MAX_RIPPLES) {
      /* Full: evict the oldest fraction-of-life, never the newest —
         a burst of splashes must not erase itself. */
      let worst = 0, worstT = -1;
      for (let k = 0; k < MAX_RIPPLES; k++) {
        const t = P.age[k] / P.life[k];
        if (t > worstT) { worstT = t; worst = k; }
      }
      i = worst;
    } else count++;

    P.x[i] = o.x; P.z[i] = o.z;
    P.r0[i] = o.r0; P.r1[i] = o.r1;
    P.w0[i] = o.w0; P.w1[i] = o.w1;
    P.str[i] = o.strength;
    P.age[i] = 0; P.life[i] = o.life;
    P.kind[i] = o.kind;
    P.dx[i] = o.dx ?? 1; P.dz[i] = o.dz ?? 0;
    P.el[i] = o.elong ?? 1;
    P.seed[i] = o.seed ?? (ctx.rng ? ctx.rng() : 0.5);
    P.vx[i] = o.vx ?? 0; P.vz[i] = o.vz ?? 0;
    return i;
  }

  /* ------------------------------------------------------------
     Public spawners. All of them take WORLD metres.
     ------------------------------------------------------------ */
  const api = {
    texture: rt.texture,
    rect,
    span: cfg.span,
    size: cfg.size,

    /** A footstep / wading / object-in-surface ring. */
    ring(x, z, strength = 0.5, radius = 0.4) {
      const s = clamp(strength, 0.05, 1);
      spawn({
        x, z, kind: RIPPLE_KIND.RING,
        r0: radius * 0.35, r1: radius + 1.5 + s * 2.6,
        w0: 0.16 + radius * 0.22, w1: 0.05 + radius * 0.1,
        strength: 0.35 + s * 0.65,
        life: 1.15 + s * 1.5,
      });
      return api;
    },

    /** An entry splash: a fat foam disc plus two chasing rings. */
    splash(x, z, strength = 0.7, radius = 0.5) {
      const s = clamp(strength, 0.08, 1);
      spawn({
        x, z, kind: RIPPLE_KIND.BLOB,
        r0: radius * 0.5, r1: radius * (1.5 + s * 1.9),
        w0: 0.3, w1: 0.12,
        strength: 0.75 + s * 0.25,
        life: 0.45 + s * 0.45,
      });
      spawn({
        x, z, kind: RIPPLE_KIND.RING,
        r0: radius * 0.7, r1: radius + 2.2 + s * 4.5,
        w0: 0.34 + s * 0.2, w1: 0.08,
        strength: 0.7 + s * 0.3,
        life: 1.5 + s * 1.4,
      });
      spawn({
        x, z, kind: RIPPLE_KIND.RING,
        r0: radius * 0.3, r1: radius + 1.1 + s * 2.2,
        w0: 0.2, w1: 0.06,
        strength: 0.45 + s * 0.3,
        life: 1.0 + s * 1.0,
      });
      return api;
    },

    /**
     * One sample of a V wake: a blob smeared along `dir` that DRIFTS
     * outward as it ages. The drift is the whole trick — blobs laid at
     * a fixed lateral offset give two parallel lines, and a real wake
     * is a V because the disturbance keeps travelling outward after
     * the hull has gone. drift ~ 0.35 * speed puts the arms at the
     * Kelvin angle without any of the arithmetic.
     */
    wakeBlob(x, z, dx, dz, strength = 0.5, radius = 0.5, life = 2.2, vx = 0, vz = 0) {
      const l = Math.hypot(dx, dz) || 1;
      spawn({
        x, z, kind: RIPPLE_KIND.WAKE,
        r0: radius, r1: radius * 1.7,
        w0: 0.2, w1: 0.1,
        strength: clamp(strength, 0.05, 1),
        life,
        dx: dx / l, dz: dz / l,
        elong: 2.2,
        vx, vz,
      });
      return api;
    },

    /** Move the field. Called with the player (or camera) position. */
    setCenter(x, z) { rect.x = x; rect.y = z; return api; },

    get count() { return count; },

    update(dt) {
      /* age, cull */
      for (let i = count - 1; i >= 0; i--) {
        P.age[i] += dt;
        if (P.age[i] >= P.life[i]) {
          const last = --count;
          if (i !== last) {
            for (const k in P) P[k][i] = P[k][last];
          }
        }
      }

      /* fill the instance buffers */
      const c = aCenter.array, p = aParams.array, s = aShape.array;
      for (let i = 0; i < count; i++) {
        const t = P.age[i] / P.life[i];
        /* Radius eases out — a real ring slows as it spreads. */
        const e = 1 - (1 - t) * (1 - t);
        const r = P.r0[i] + (P.r1[i] - P.r0[i]) * e;
        const w = P.w0[i] + (P.w1[i] - P.w0[i]) * e;
        /* Foam fades late and fast: it should hold its opacity and
           then go, not dissolve from birth (§5.4 — no soft alpha). */
        const fade = 1 - t * t * t;
        c[i * 2] = P.x[i] + P.vx[i] * P.age[i];
        c[i * 2 + 1] = P.z[i] + P.vz[i] * P.age[i];
        p[i * 4] = r;
        p[i * 4 + 1] = w;
        p[i * 4 + 2] = P.str[i] * fade;
        p[i * 4 + 3] = P.kind[i];
        s[i * 4] = P.dx[i]; s[i * 4 + 1] = P.dz[i];
        s[i * 4 + 2] = P.el[i]; s[i * 4 + 3] = P.seed[i];
      }
      aCenter.needsUpdate = true;
      aParams.needsUpdate = true;
      aShape.needsUpdate = true;
      geo.instanceCount = count;
    },

    /* Draw the field. Separate from update() so water.js controls when
       in the frame the render target is touched. */
    render(renderer) {
      /* renderer.js sets its own clear colour and target at the top of
         every pass, so we only have to leave the target where we found
         it. */
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      if (count > 0) renderer.render(scene, cam);
      renderer.setRenderTarget(prevTarget);
    },

    clear() { count = 0; geo.instanceCount = 0; },

    dispose() {
      rt.dispose();
      geo.dispose();
      mat.dispose();
    },
  };

  return api;
}

export default createRipples;
