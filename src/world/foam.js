/* ============================================================
   foam.js — the two pieces of foam that do NOT live in the ocean
   shader: the beach run-up and the splash droplets.

   Owned by the water agent; created by water.js, not booted by main.

   1. THE SHORE SKIRT.
      The ocean surface is opaque and stops dead at the waterline, so
      everything that happens ABOVE it — the sheet of foam that slides
      up the sand and slides back, and the dark wet band it leaves —
      has to be painted on the land. This is a ring of geometry that
      follows the real terrain: for each of A angles around the island
      we march radially for the height-zero crossing and lay a strip of
      quads from a little seaward of it to `INLAND` metres up the
      beach, sitting on ctx.world.heightAt() so it conforms to whatever
      the terrain agent sculpts.

      It shares `uSurge` with the ocean shader, which is what makes the
      run-up on the sand and the foam band in the water the same swell
      rather than two effects that happen to both be white.

   2. SPLASH DROPLETS.
      Hard-edged opaque blobs, no soft alpha, stretched along their own
      velocity, tumbling and falling back. ART_DIRECTION §5.4 is
      explicit that Wind Waker foam has a crisp edge — these discard
      rather than blend, so they keep it at every distance.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { SEA, LAND } from '../core/palette.js';
import { clamp } from '../core/contracts.js';
import { WORLD } from '../game/data.js';

const MAX_DROPS = 220;

export function createFoam(ctx, shared) {
  const THREE_ = ctx.THREE || THREE;
  const srgb = (hex) => new THREE_.Color().setHex(hex, THREE_.SRGBColorSpace);
  const q = ctx.quality || {};

  const group = new THREE_.Group();
  group.name = 'water.foam';
  group.matrixAutoUpdate = false;

  /* ================================================================
     1. SHORE SKIRT
     ================================================================ */
  const ANG = q.name === 'low' ? 192 : 384;   // angular samples round the island
  const RAD = 7;                              // strips from sea to inland
  const INLAND = 7.5;                         // metres of wet sand painted
  const SEAWARD = 1.2;                        // metres past the crossing

  const skirtMat = new THREE_.ShaderMaterial({
    name: 'water.shoreSkirt',
    transparent: true,
    depthWrite: false,
    side: THREE_.DoubleSide,
    /* A slope-scaled polygon offset is the wrong tool for a decal
       that is looked at edge-on: at grazing incidence the depth
       gradient is enormous, factor -2 pulled the skirt metres toward
       the lens, and a band of wet sand rendered on top of the open
       water in front of it. Almost all of the bias is now the
       constant term. */
    polygonOffset: true,
    polygonOffsetFactor: -0.6,
    polygonOffsetUnits: -4,
    uniforms: {
      uTime: shared.uniforms.uTime,
      uSurge: shared.uniforms.uSurge,
      uWindDir: shared.uniforms.uWindDir,
      uFoam: { value: srgb(SEA.foam) },
      uWet: { value: srgb(LAND.sandWet) },
      uWetTint: { value: srgb(SEA.wet) },
      uOpacity: { value: 1.0 },
      /* Shared by reference with ctx.mat, so the surf is lit by the
         same sun as the sand it is lying on. An unlit white ribbon on
         a lit beach reads as a strip of paper. */
      uSunColor: shared.uniforms.uSunColor,
      uSunIntensity: shared.uniforms.uSunIntensity,
      uAmbSky: shared.uniforms.uAmbSky,
      uAmbIntensity: shared.uniforms.uAmbIntensity,
    },
    vertexShader: /* glsl */`
      attribute vec3 aShore;    // x: metres inland, y: 0 = dead slice, z: ground height
      attribute float aArc;     // metres along the shoreline, for the wobble
      varying vec3 vShore;
      varying float vArc;
      varying float vFade;
      void main() {
        vShore = aShore;
        vArc = aArc;
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vec4 mv = viewMatrix * wp;
        gl_Position = projectionMatrix * mv;
        vFade = 1.0 - smoothstep( 170.0, 320.0, -mv.z );
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime;
      uniform float uSurge;
      uniform vec2  uWindDir;
      uniform vec3  uFoam;
      uniform vec3  uWet;
      uniform vec3  uWetTint;
      uniform float uOpacity;
      uniform vec3  uSunColor;
      uniform float uSunIntensity;
      uniform vec3  uAmbSky;
      uniform float uAmbIntensity;
      varying vec3 vShore;
      varying float vArc;
      varying float vFade;

      void main() {
        if ( vShore.y < 0.5 ) discard;
        /* ONLY ON DRY LAND. The crossing search can land on a shoal
           sitting a few centimetres under the surface, and a strip of
           wet sand painted across open water is worse than no strip at
           all. A quarter of a metre of slack lets the sheet run down
           into the trough of the swell and no further. */
        if ( vShore.z < -0.26 ) discard;
        float u = vShore.x;                     // metres inland of the waterline

        /* The swell does not arrive as one straight line — it runs up
           in tongues. Two travelling waves along the shore, plus a
           slow one, give a ragged edge that moves sideways as well as
           up the sand. */
        float w = sin( vArc * 0.21 - uTime * 0.55 ) * 0.55
                + sin( vArc * 0.061 + uTime * 0.31 ) * 0.9
                + sin( vArc * 0.53 + uTime * 0.9 ) * 0.22;

        /* Run-up: the leading edge of the sheet, in metres inland. */
        float reach = mix( -0.30, 2.4, uSurge ) + w * ( 0.45 + 0.5 * uSurge );

        /* HARD edge (§5.4). fwidth keeps it one pixel wide at any
           distance instead of one metre wide up close. */
        float aa = max( fwidth( u ) * 0.9, 0.012 );
        float sheet = 1.0 - smoothstep( reach - aa, reach + aa, u );

        /* The trailing edge: the sheet is a band, not a flood — behind
           it the water has already drained back into the sand. */
        float back = reach - ( 0.7 + 1.1 * uSurge );
        sheet *= smoothstep( back - aa - 0.25, back + aa, u );

        /* Wet sand reaches further than the foam does and dries out
           over the following seconds, so its edge lags the surge. */
        float wetReach = 2.7 + w * 0.7;
        float wet = 1.0 - smoothstep( wetReach - 0.55, wetReach + 0.25, u );
        /* seaward of the waterline it is simply underwater sand */
        wet = max( wet, 1.0 - smoothstep( -0.15, 0.35, u ) );

        vec3 col = mix( uWet * 0.74, uWetTint, 0.30 );
        float a = wet * 0.80;

        col = mix( col, uFoam, sheet );
        a = mix( a, 1.0, sheet );

        /* A thin bright lip right at the leading edge — the crest of
           the sheet catches the sun and it is what makes the run-up
           read as water and not as a white decal. */
        float lip = ( 1.0 - smoothstep( reach - 0.42, reach, u ) )
                  * smoothstep( reach - 0.62, reach - 0.42, u );
        col = mix( col, vec3( 1.0 ), lip * 0.55 );

        /* Same normalised ambient as the ocean shader — the raw sky
           colour is a saturated blue and using it as a light source
           turns white surf lilac. */
        vec3 ambHue = uAmbSky / max( dot( uAmbSky, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 );
        col *= uSunColor * uSunIntensity * 0.62
             + mix( vec3( 1.0 ), ambHue, 0.55 ) * uAmbIntensity;

        a *= uOpacity * vFade * smoothstep( -0.26, 0.04, vShore.z );
        if ( a < 0.01 ) discard;
        gl_FragColor = vec4( col, a );
      }
    `,
  });

  let skirt = null;

  function buildSkirt() {
    if (skirt) {
      group.remove(skirt);
      skirt.geometry.dispose();
      skirt = null;
    }

    const groundAt = shared.groundAt;
    const nVert = (ANG + 1) * RAD;
    const pos = new Float32Array(nVert * 3);
    const shore = new Float32Array(nVert * 3);
    const arc = new Float32Array(nVert);
    const idx = [];

    const RX = WORLD.islandRadiusX, RZ = WORLD.islandRadiusZ;

    for (let a = 0; a <= ANG; a++) {
      const th = (a / ANG) * Math.PI * 2;
      const ca = Math.cos(th), sa = Math.sin(th);
      /* Unit-ellipse ray. `re` is the ellipse radius along it, so a
         step of 1 in `s` is 1 metre along the ray. */
      const ex = RX * ca, ez = RZ * sa;
      const re = Math.hypot(ex, ez);
      const dx = ex / re, dz = ez / re;

      /* March IN from open water for the first dry ground, then
         bisect. Marching outward instead finds whichever sandbar the
         ray meets first and hangs the whole strip off it. */
      let cross = re;
      let valid = 0;
      let sPrev = re * 1.3;
      let hPrev = groundAt(dx * sPrev, dz * sPrev);
      for (let s = re * 1.3 - 2; s > re * 0.3; s -= 2) {
        const h = groundAt(dx * s, dz * s);
        if (h > 0.06) {
          let a0 = s, a1 = sPrev;
          for (let it = 0; it < 20; it++) {
            const sm = (a0 + a1) * 0.5;
            if (groundAt(dx * sm, dz * sm) > 0) a0 = sm; else a1 = sm;
          }
          cross = (a0 + a1) * 0.5;
          valid = 1;
          break;
        }
        sPrev = s; hPrev = h;
      }

      const arcLen = th * (RX + RZ) * 0.5;

      for (let k = 0; k < RAD; k++) {
        const t = k / (RAD - 1);
        const u = -SEAWARD + t * (INLAND + SEAWARD);   // metres inland
        const s = cross - u;                            // inland = smaller radius
        const x = dx * s, z = dz * s;
        const y = groundAt(x, z);
        const i = a * RAD + k;
        pos[i * 3] = x;
        pos[i * 3 + 1] = y + 0.035;
        pos[i * 3 + 2] = z;
        shore[i * 3] = u;
        shore[i * 3 + 1] = valid;
        shore[i * 3 + 2] = y;
        arc[i] = arcLen;
      }
    }

    for (let a = 0; a < ANG; a++) {
      for (let k = 0; k < RAD - 1; k++) {
        const i0 = a * RAD + k;
        const i1 = (a + 1) * RAD + k;
        idx.push(i0, i1, i0 + 1, i1, i1 + 1, i0 + 1);
      }
    }

    const g = new THREE_.BufferGeometry();
    g.setAttribute('position', new THREE_.BufferAttribute(pos, 3));
    g.setAttribute('aShore', new THREE_.BufferAttribute(shore, 3));
    g.setAttribute('aArc', new THREE_.BufferAttribute(arc, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();

    skirt = new THREE_.Mesh(g, skirtMat);
    skirt.name = 'water.shoreSkirt';
    skirt.renderOrder = 3;
    skirt.frustumCulled = true;
    skirt.castShadow = false;
    skirt.receiveShadow = false;
    skirt.userData.noPrepass = true;
    skirt.userData.noOutline = true;
    group.add(skirt);
  }

  /* ================================================================
     2. SPLASH DROPLETS
     ================================================================ */
  const D = {
    x: new Float32Array(MAX_DROPS), y: new Float32Array(MAX_DROPS), z: new Float32Array(MAX_DROPS),
    vx: new Float32Array(MAX_DROPS), vy: new Float32Array(MAX_DROPS), vz: new Float32Array(MAX_DROPS),
    size: new Float32Array(MAX_DROPS),
    age: new Float32Array(MAX_DROPS), life: new Float32Array(MAX_DROPS),
    seed: new Float32Array(MAX_DROPS),
  };
  let dCount = 0;

  const dPos = new THREE_.InstancedBufferAttribute(new Float32Array(MAX_DROPS * 3), 3);
  const dPar = new THREE_.InstancedBufferAttribute(new Float32Array(MAX_DROPS * 4), 4);
  const dVel = new THREE_.InstancedBufferAttribute(new Float32Array(MAX_DROPS * 3), 3);
  dPos.setUsage(THREE_.DynamicDrawUsage);
  dPar.setUsage(THREE_.DynamicDrawUsage);
  dVel.setUsage(THREE_.DynamicDrawUsage);

  const dGeo = new THREE_.InstancedBufferGeometry();
  {
    const p = new THREE_.PlaneGeometry(1, 1);
    dGeo.setAttribute('position', p.getAttribute('position'));
    dGeo.setAttribute('uv', p.getAttribute('uv'));
    dGeo.setIndex(p.getIndex());
    p.dispose();
  }
  dGeo.setAttribute('aPos', dPos);
  dGeo.setAttribute('aPar', dPar);
  dGeo.setAttribute('aVel', dVel);
  dGeo.instanceCount = 0;
  dGeo.boundingSphere = new THREE_.Sphere(new THREE_.Vector3(), 1e6);

  const dropMat = new THREE_.ShaderMaterial({
    name: 'water.droplets',
    transparent: false,
    depthWrite: true,
    side: THREE_.DoubleSide,
    uniforms: {
      uFoam: { value: srgb(SEA.foam) },
      uShade: { value: srgb(SEA.shallow) },
      uSunDir: shared.uniforms.uSunDir,
    },
    vertexShader: /* glsl */`
      attribute vec3 aPos;
      attribute vec4 aPar;   // size, life01, seed, spin
      attribute vec3 aVel;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;
      void main() {
        vUv = uv;
        vLife = aPar.y;
        vSeed = aPar.z;

        vec4 mv = viewMatrix * vec4( aPos, 1.0 );
        /* Stretch along the screen-space velocity: a droplet in flight
           is a streak, a settling one is a bead. */
        vec3 vv = ( viewMatrix * vec4( aVel, 0.0 ) ).xyz;
        float sp = length( vv.xy );
        vec2 dir = sp > 0.001 ? vv.xy / sp : vec2( 0.0, 1.0 );
        float stretch = 1.0 + min( sp * 0.10, 1.5 );
        vec2 o = position.xy * aPar.x;
        o = vec2( dot( o, vec2( dir.y, -dir.x ) ), dot( o, dir ) * stretch );
        mv.xy += o;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uFoam;
      uniform vec3 uShade;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float d = dot( p, p );
        /* Hard edge. The droplet shrinks over its life instead of
           fading — opaque foam does not become translucent (§5.4). */
        float r = 1.0 - smoothstep( 0.45, 1.0, vLife );
        if ( d > r * r ) discard;
        /* A single soft form tone so a blob still reads as a blob. */
        float form = smoothstep( 1.0, -0.2, ( p.x * 0.6 + p.y ) );
        vec3 col = mix( uFoam, mix( uShade, uFoam, 0.55 ), form * 0.55 );
        gl_FragColor = vec4( col, 1.0 );
      }
    `,
  });

  const drops = new THREE_.Mesh(dGeo, dropMat);
  drops.name = 'water.droplets';
  drops.frustumCulled = false;
  drops.castShadow = false;
  drops.receiveShadow = false;
  drops.renderOrder = 4;
  drops.userData.noPrepass = true;
  drops.userData.noOutline = true;
  group.add(drops);

  const rnd = ctx.makeRng ? ctx.makeRng('foam') : Math.random;

  function emitDrop(x, y, z, vx, vy, vz, size, life) {
    let i = dCount;
    if (dCount >= MAX_DROPS) {
      let worst = 0, worstT = -1;
      for (let k = 0; k < MAX_DROPS; k++) {
        const t = D.age[k] / D.life[k];
        if (t > worstT) { worstT = t; worst = k; }
      }
      i = worst;
    } else dCount++;
    D.x[i] = x; D.y[i] = y; D.z[i] = z;
    D.vx[i] = vx; D.vy[i] = vy; D.vz[i] = vz;
    D.size[i] = size;
    D.age[i] = 0; D.life[i] = life;
    D.seed[i] = rnd();
  }

  const api = {
    group,
    get dropCount() { return dCount; },
    get skirt() { return skirt; },

    rebuildSkirt: buildSkirt,

    /** A burst of droplets at a water impact. strength 0..1 */
    burst(x, y, z, strength = 0.6, particles = null) {
      const s = clamp(strength, 0.06, 1);
      const n = Math.round((particles ?? (5 + s * 16)) * (q.particles ?? 1));
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const sp = (1.4 + rnd() * 3.4) * (0.45 + s);
        const up = (2.2 + rnd() * 3.6) * (0.4 + s * 0.9);
        emitDrop(
          x + Math.cos(a) * 0.12, y + 0.05, z + Math.sin(a) * 0.12,
          Math.cos(a) * sp, up, Math.sin(a) * sp,
          (0.045 + rnd() * 0.085) * (0.7 + s * 0.8),
          0.5 + rnd() * 0.55 + s * 0.35,
        );
      }
      return api;
    },

    update(dt) {
      /* droplets */
      const level = shared.level;
      for (let i = dCount - 1; i >= 0; i--) {
        D.age[i] += dt;
        D.vy[i] -= 21 * dt;
        D.vx[i] *= 1 - 1.1 * dt;
        D.vz[i] *= 1 - 1.1 * dt;
        D.x[i] += D.vx[i] * dt;
        D.y[i] += D.vy[i] * dt;
        D.z[i] += D.vz[i] * dt;
        const dead = D.age[i] >= D.life[i] || D.y[i] < level - 0.25;
        if (dead) {
          const last = --dCount;
          if (i !== last) for (const k in D) D[k][i] = D[k][last];
        }
      }
      const p = dPos.array, q4 = dPar.array, v = dVel.array;
      for (let i = 0; i < dCount; i++) {
        p[i * 3] = D.x[i]; p[i * 3 + 1] = D.y[i]; p[i * 3 + 2] = D.z[i];
        q4[i * 4] = D.size[i];
        q4[i * 4 + 1] = D.age[i] / D.life[i];
        q4[i * 4 + 2] = D.seed[i];
        q4[i * 4 + 3] = 0;
        v[i * 3] = D.vx[i]; v[i * 3 + 1] = D.vy[i]; v[i * 3 + 2] = D.vz[i];
      }
      dPos.needsUpdate = dPar.needsUpdate = dVel.needsUpdate = true;
      dGeo.instanceCount = dCount;
      drops.visible = dCount > 0;
    },

    dispose() {
      if (skirt) { skirt.geometry.dispose(); group.remove(skirt); }
      skirtMat.dispose();
      dGeo.dispose();
      dropMat.dispose();
      group.parent?.remove(group);
    },
  };

  buildSkirt();
  return api;
}

export default createFoam;
