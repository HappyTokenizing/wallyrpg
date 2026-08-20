/* ============================================================
   clouds.js — stylised cumulus that read as VOLUME.

   ART_DIRECTION: Wind Waker's clouds look *modelled*. A flat alpha
   plane is a fail. So each cloud here is a cluster of 10–20 shaded
   sphere impostors — camera-facing quads that reconstruct a real
   surface normal from the quad's own coordinates, erode their
   silhouette with world-space value noise, and are lit as one form.

   Three details do all the work:

   1. THE CLOUD-LEVEL NORMAL. Shading each puff with its own sphere
      normal gives a bag of independently lit balls. The shading
      normal is therefore blended toward the direction from the
      cloud's centre to the puff, so the whole cluster carries one
      light wrap: lit top, shadowed underside, and a terminator that
      runs across the cloud instead of around every lump.

   2. EROSION. A sphere impostor left alone has a circular
      silhouette, and a dozen circles read as a dozen circles. Two
      octaves of value noise sampled on the *world-space* sphere
      normal (so it does not swim when the camera turns) cut the rim
      into a lumpy, cauliflower edge.

   3. FORWARD SCATTER. Thin parts of a cloud with the sun behind them
      glow — the silver lining. `pow(dot(V, L), 6) * thinness` is the
      cheapest honest version of it and it is most of why a stylised
      cloud stops looking like cotton wool.

   Blending is back-to-front: all puffs live in one InstancedMesh
   (one draw call) and the instance buffer is written in view-depth
   order, resorted a few times a second. Alpha-blended impostors
   composited in the wrong order have visibly wrong undersides,
   which is exactly the detail this file exists to get right.

   Colour comes entirely from palette.js — BRAND.paper is the warm
   near-white a lit cloud top actually is, SEA.foam the highlight,
   SHADOW.tint the law that keeps the underside blue-violet and
   never grey (§2.1, §7).
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BRAND, SEA, SHADOW, SKY } from '../core/palette.js';
import { clamp, lerp, smoothstep, damp } from '../core/contracts.js';

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const TAU = Math.PI * 2;

/* hoisted: these are read every frame and a THREE.Color per frame per
   cloud parameter is a garbage-collection sawtooth for nothing */
const C_PAPER = srgb(BRAND.paper);
const C_TINT = srgb(SHADOW.tint);
const C_FOAM = srgb(SEA.foam);

const CLOUD_GLSL_NOISE = /* glsl */`
  float cHash13( vec3 p3 ) {
    p3 = fract( p3 * 0.1031 );
    p3 += dot( p3, p3.zyx + 31.32 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
  float cValue3( vec3 x ) {
    vec3 i = floor( x );
    vec3 f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    float n000 = cHash13( i );
    float n100 = cHash13( i + vec3( 1.0, 0.0, 0.0 ) );
    float n010 = cHash13( i + vec3( 0.0, 1.0, 0.0 ) );
    float n110 = cHash13( i + vec3( 1.0, 1.0, 0.0 ) );
    float n001 = cHash13( i + vec3( 0.0, 0.0, 1.0 ) );
    float n101 = cHash13( i + vec3( 1.0, 0.0, 1.0 ) );
    float n011 = cHash13( i + vec3( 0.0, 1.0, 1.0 ) );
    float n111 = cHash13( i + vec3( 1.0, 1.0, 1.0 ) );
    return mix(
      mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
      mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );
  }
`;

export function createClouds(ctx) {
  const q = ctx.quality;
  const rng = ctx.makeRng('sky.clouds.v1');

  /* Budget. Every number here scales with the quality tier, because
     a cloud impostor is pure fill rate and nothing else. */
  const tier = String(q.name || 'high').replace(/\(.*/, '');
  const BUDGET = { low: 0.42, med: 0.68, high: 1.0, ultra: 1.3 }[tier] ?? 1.0;
  const OCTAVES = tier === 'low' ? 1 : 2;

  const N_MAIN = Math.round(40 * BUDGET);      // the big cumulus
  const N_FAR = Math.round(30 * BUDGET);       // small ones down at the horizon
  const MAX_PUFFS = Math.round(1400 * BUDGET);

  /* Wrap radius in XZ around the camera. It is large, and the
     altitudes below are chosen against it, because of where the
     game's camera actually points: the follow rig sits at -9 degrees
     of pitch, so a 47-degree frame sees roughly 0 to +16 degrees of
     sky. Clouds parked at 250 m directly overhead are at 80 degrees
     and are never in a single gameplay frame. The whole field is
     therefore placed to land in the 4-18 degree band where it can be
     seen — which is also where Wind Waker puts its clouds. */
  const FIELD = 2100;

  /* ------------------------------------------------------------
     Cloud construction.

     A cumulus is not a ball: it has a flat, wide base and a domed,
     towering top. Puffs are therefore laid out on a profile that
     narrows with height, with the largest radii at the bottom — that
     shape is the whole silhouette, and the silhouette is what reads
     from 400 m away.
     ------------------------------------------------------------ */
  function buildCloud(i, far) {
    /* Big. At ~1400 m a 130 m cloud subtends 10 degrees, which is
       about what a Wind Waker cumulus occupies; anything smaller
       reads as a speck no matter how well it is shaded. */
    const R = far ? 60 + rng() * 60 : 140 + rng() * 145;
    const H = R * (far ? 0.42 : 0.55 + rng() * 0.30);
    const n = Math.max(6, Math.round((far ? 7 : 12) + rng() * (far ? 4 : 9)));

    const puffs = [];
    for (let k = 0; k < n; k++) {
      /* Two thirds of the puffs live in the lower half — that is what
         makes the base flat and the top domed rather than the whole
         thing spherical. */
      const u = Math.pow(k / Math.max(1, n - 1), 1.45);
      const ring = Math.pow(rng(), 0.55);
      const rad = R * (1 - u * 0.74) * (0.20 + 0.88 * ring);
      const ang = rng() * TAU;
      const ox = Math.cos(ang) * rad;
      const oz = Math.sin(ang) * rad * (0.72 + rng() * 0.35);
      const oy = H * (u * 0.92 + (rng() - 0.5) * 0.10);
      const pr = R * (0.30 + 0.28 * (1 - u)) * (0.78 + 0.46 * rng());
      puffs.push({
        ox, oy: Math.max(0, oy), oz,
        r: pr,
        seed: rng() * 90,
        h01: clamp(oy / Math.max(H, 1e-3), 0, 1),
        /* each puff breathes on its own slow phase — "reshape
           slowly", not a pulsing balloon */
        bp: rng() * TAU,
        bs: 0.035 + rng() * 0.05,
      });
    }

    return {
      x: (rng() - 0.5) * 2 * FIELD,
      z: (rng() - 0.5) * 2 * FIELD,
      /* Altitude is set from the cloud's own distance so its
         elevation angle lands in the visible band rather than
         overhead. Recomputed on wrap for the same reason. */
      y: 0,
      R, H, puffs,
      /* Coverage threshold: as the weather's cloud parameter rises,
         clouds fade in one after another. Never a pop — the fade is
         a smoothstep over 0.24 of a parameter that itself takes
         minutes to move. */
      thr: far ? (i / Math.max(1, N_FAR)) * 0.85 : (i / Math.max(1, N_MAIN)) * 0.98,
      spin: (rng() - 0.5) * 0.06,
      op: 0,
      far,
    };
  }

  /* ALTITUDE IS FIXED, NOT DERIVED FROM DISTANCE.

     The first version hung each cloud at a constant elevation ANGLE,
     which is the right instinct and the wrong implementation: a cloud
     that drifts near the camera's own XZ then has almost no altitude,
     and a 200 m-wide cumulus at 80 m up passing overhead fills two
     thirds of the frame with a lavender disc. (It did. See sky-7.)

     A fixed high band fixes it geometrically. At 560 m up, a cloud
     directly overhead is still 560 m away and sits at 62 degrees —
     nowhere near a rig that pitches down 9. At the field edge it is
     at 15 degrees, which is exactly the band a gameplay camera sees.
     Distance can now do whatever it likes and nothing ever lands in
     the player's face. */
  const clouds = [];
  for (let i = 0; i < N_MAIN; i++) clouds.push(buildCloud(i, false));
  for (let i = 0; i < N_FAR; i++) clouds.push(buildCloud(i, true));
  for (const c of clouds) c.y = c.far ? 210 + rng() * 150 : 430 + rng() * 330;

  /* flat puff list, so the per-frame write is one linear pass */
  const flat = [];
  for (const c of clouds) for (const p of c.puffs) flat.push({ c, p });
  const COUNT = Math.min(flat.length, MAX_PUFFS);

  /* ------------------------------------------------------------
     Geometry — one quad, instanced.
     ------------------------------------------------------------ */
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);

  const aPos = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
  const aData = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 4), 4);
  const aCloud = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 4), 4);
  aPos.setUsage(THREE.DynamicDrawUsage);
  aData.setUsage(THREE.DynamicDrawUsage);
  aCloud.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', aPos);
  geo.setAttribute('iData', aData);
  geo.setAttribute('iCloud', aCloud);
  geo.instanceCount = 0;

  const uniforms = {
    uSunDir:    { value: new THREE.Vector3(0.46, 0.72, 0.52) },
    uLit:       { value: srgb(BRAND.paper) },
    uShade:     { value: srgb(SHADOW.tint) },
    uSilver:    { value: srgb(SEA.foam) },
    uFog:       { value: srgb(SKY.haze) },
    /* A soft silhouette is asked for; a MUSHY one is not. 0.20 of
       edge feather on a sphere impostor is a third of the puff's
       radius and every cloud read as cotton wool. 0.13 keeps the
       2-3 px of softness the art direction wants and lets the
       erosion actually be seen. */
    uErode:     { value: 0.44 },
    uEdge:      { value: 0.13 },
    uNoiseScale:{ value: 4.2 },
    uSilverAmt: { value: 0.85 },
    uHaze:      { value: 0.42 },
    uCoreLift:  { value: 0.34 },
  };

  const mat = new THREE.ShaderMaterial({
    name: 'sky.clouds',
    uniforms,
    defines: { CLOUD_OCTAVES: OCTAVES },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */`
      attribute vec3 iPos;
      attribute vec4 iData;    // x radius  y seed  z height01  w opacity
      attribute vec4 iCloud;   // xyz cloud centre  w cloud radius

      varying vec2  vP;
      varying vec3  vCloudN;
      varying vec3  vWorld;
      varying float vSeed;
      varying float vH01;
      varying float vOpacity;
      varying float vDist;

      void main() {
        float r = iData.x;
        vec4 mv = modelViewMatrix * vec4( iPos, 1.0 );
        /* billboard in view space: the quad always faces the camera,
           which is what lets the fragment shader treat it as a sphere */
        mv.xy += position.xy * ( 2.0 * r );
        vP = position.xy * 2.0;
        vDist = - mv.z;
        vSeed = iData.y;
        vH01 = iData.z;
        vOpacity = iData.w;
        vCloudN = ( iPos - iCloud.xyz ) / max( iCloud.w, 1.0 );
        vWorld = iPos;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3  uSunDir, uLit, uShade, uSilver, uFog;
      uniform float uErode, uEdge, uNoiseScale, uSilverAmt, uHaze, uCoreLift;

      varying vec2  vP;
      varying vec3  vCloudN;
      varying vec3  vWorld;
      varying float vSeed;
      varying float vH01;
      varying float vOpacity;
      varying float vDist;

${CLOUD_GLSL_NOISE}

      void main() {
        vec2 p = vP;
        float r2 = dot( p, p );
        if ( r2 > 1.0 ) discard;

        /* the impostor's own sphere normal, taken back into world
           space through the (orthonormal) view rotation so the noise
           below is anchored to the world and not to the screen */
        float z0 = sqrt( max( 1.0 - r2, 1e-4 ) );
        vec3 nView = vec3( p, z0 );
        vec3 nWorld = normalize( nView * mat3( viewMatrix ) );

        vec3 np = nWorld * uNoiseScale + vec3( vSeed );
        float n = cValue3( np ) * 0.66;
        #if CLOUD_OCTAVES > 1
          n += cValue3( np * 2.37 + 5.1 ) * 0.34;
        #else
          n += 0.17;
        #endif

        /* EROSION HAS TO MOVE THE RADIUS, NOT THE THICKNESS.

           Subtracting the noise from z looks equivalent and is not:
           z = sqrt(1 - r^2) is almost flat near the centre and almost
           vertical at the rim, so a 0.44 subtraction moved the
           silhouette from r = 1.00 to r = 0.90 and every cloud still
           read as a bag of circles. Scaling the radius directly with
           the same number swings it from 1.00 to 0.56, which is a
           cauliflower. */
        float rad = 1.0 - uErode * ( 1.0 - n );
        float t2 = rad * rad - r2;
        if ( t2 <= 0.0 ) discard;
        float z = sqrt( t2 ) / rad;          // 0 at the eroded rim, 1 at the core

        float a = smoothstep( 0.0, uEdge, z ) * vOpacity;
        if ( a < 0.004 ) discard;

        /* ---- shade the CLOUD, not the puff ---- */
        vec3 cn = normalize( vCloudN + vec3( 0.0, 0.42, 0.0 ) );
        vec3 N = normalize( mix( nWorld, cn, 0.62 ) );

        float ndl = dot( N, uSunDir );
        float lit = smoothstep( -0.26, 0.32, ndl );
        /* the base of a cumulus sits in the cloud's own shadow */
        lit *= mix( 0.26, 1.0, smoothstep( 0.0, 0.72, vH01 ) );
        lit *= mix( 0.52, 1.0, smoothstep( -0.70, 0.22, N.y ) );
        /* the noise doubles as surface relief so the lit face is not
           one flat tone */
        lit *= 0.86 + 0.28 * n;

        /* Puffs buried inside the cluster are occluded by the ones
           around them. Without this the interior lobes composite
           BRIGHTER than the surface ones and a cloud reads as stacked
           translucent paper rather than as one solid mass. */
        float depthIn = 1.0 - clamp( length( vCloudN ) / 0.85, 0.0, 1.0 );
        lit *= mix( 1.0, 0.70, depthIn );

        vec3 col = mix( uShade, uLit, clamp( lit, 0.0, 1.0 ) );
        /* third tone where the top turns fully into the key (§2.2) */
        col += ( uLit - uShade ) * smoothstep( 0.52, 0.92, ndl ) * uCoreLift
             * smoothstep( 0.25, 0.8, vH01 );

        /* ---- silver lining ---- */
        vec3 V = normalize( vWorld - cameraPosition );
        float fwd = max( dot( V, uSunDir ), 0.0 );
        float thin = pow( 1.0 - z, 2.2 );
        col += uSilver * pow( fwd, 6.0 ) * thin * uSilverAmt;
        /* and a gentler wrap right around the whole silhouette */
        col += uSilver * pow( fwd, 2.4 ) * pow( 1.0 - z, 5.0 ) * uSilverAmt * 0.5;

        /* Contact shading where one lobe meets the next: darken each
           puff's own rim, except where the sun is behind it and the
           rim is the thing that should be glowing. */
        col = mix( col, uShade, pow( 1.0 - z, 3.0 ) * 0.28 * ( 1.0 - fwd ) );

        /* ---- distance haze (§2.4) ---- */
        col = mix( col, uFog, uHaze * smoothstep( 200.0, 1500.0, vDist ) );

        gl_FragColor = vec4( col, a );
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky.clouds';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = -900;      // behind everything else transparent
  mesh.userData.noPrepass = true;
  mesh.userData.noOutline = true;
  ctx.scene.add(mesh);

  /* ------------------------------------------------------------
     Per-frame
     ------------------------------------------------------------ */
  const order = new Int32Array(COUNT);
  const depth = new Float32Array(COUNT);
  const wpos = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) order[i] = i;

  let sortT = 0;
  let active = 0;
  const _c = new THREE.Color();
  const _shade = new THREE.Color();

  /* Cloud shadow on the ground: how much of the sun the cloud field
     is eating right now. Cheap — one distance-to-ray test per cloud,
     not per puff. Read by sky.js and folded into the key intensity so
     a cloud crossing the sun actually dims the world. */
  function sunOcclusion(camPos, sunDir) {
    let occ = 0;
    for (const c of clouds) {
      if (c.op < 0.02) continue;
      const dx = c.x - camPos.x, dy = c.y - camPos.y, dz = c.z - camPos.z;
      const t = dx * sunDir.x + dy * sunDir.y + dz * sunDir.z;
      if (t <= 0) continue;
      const px = dx - sunDir.x * t, py = dy - sunDir.y * t, pz = dz - sunDir.z * t;
      const dist = Math.sqrt(px * px + py * py + pz * pz);
      occ = Math.max(occ, c.op * (1 - smoothstep(c.R * 0.35, c.R * 1.25, dist)));
    }
    return occ;
  }

  let occSmooth = 0;

  const api = {
    mesh, uniforms, clouds,
    get occlusion() { return occSmooth; },

    update(dt, elapsed, sunDir, colors, wx) {
      const cam = ctx.camera;
      const cp = cam ? cam.position : { x: 0, y: 2, z: 0 };

      /* ---- drift on the global wind field (§2.3) ---- */
      const wd = ctx.wind?.uniforms?.uWindDir?.value;
      const ws = ctx.wind ? ctx.wind.strength : 0.42;
      const speed = (5.5 + ws * 16) * (1 + wx.storm * 0.8);
      const vx = (wd ? wd.x : 1) * speed * dt;
      const vz = (wd ? wd.y : 0) * speed * dt;

      for (const c of clouds) {
        c.x += vx;
        c.z += vz;
        /* wrap around the camera so the field is endless */
        const rx = c.x - cp.x, rz = c.z - cp.z;
        if (rx > FIELD) c.x -= FIELD * 2; else if (rx < -FIELD) c.x += FIELD * 2;
        if (rz > FIELD) c.z -= FIELD * 2; else if (rz < -FIELD) c.z += FIELD * 2;
        const want = smoothstep(c.thr, c.thr + 0.24, wx.cloud);
        c.op = damp(c.op, want, 0.5, dt);
      }

      /* ---- colours ----
         The lit tone is the cloud's warm near-white put through the
         actual key; the shade tone is that colour put through §2.1's
         law rather than multiplied down, so an overcast underside is
         blue-violet and never grey. */
      const sunI = ctx.render?.csm?.sunIntensity ?? 0.7;
      /* The lit tone leans hard on the SUN, not on the sky: at 07:00
         a cloud top is pink, and a 50/50 blend with a blue zenith
         made every dawn cloud lavender. The fill comes from the
         horizon rather than the zenith for the same reason — that is
         the part of the sky a cumulus at 15 degrees can actually
         see. */
      _c.copy(colors.sunColor).multiplyScalar(0.62 + sunI * 1.25)
        .add(_shade.copy(colors.horizonOut).multiplyScalar(0.26));
      _c.multiply(C_PAPER);
      /* storm drains the albedo toward the shadow tint */
      if (wx.storm > 0.001) _c.lerp(C_TINT, wx.storm * 0.55);
      uniforms.uLit.value.copy(_c);

      _shade.copy(_c).multiply(C_TINT);
      _shade.lerp(_c, 1 - SHADOW.amount);          // the law, verbatim
      _shade.lerp(colors.horizonOut, 0.07 + 0.20 * wx.cloud);
      uniforms.uShade.value.copy(_shade);

      uniforms.uSilver.value.copy(colors.haloColor).lerp(C_FOAM, 0.35);
      uniforms.uSilverAmt.value = lerp(0.95, 0.20, wx.storm) * (0.25 + sunI);
      uniforms.uFog.value.copy(colors.fogOut);
      uniforms.uSunDir.value.copy(sunDir);
      uniforms.uErode.value = lerp(0.44, 0.30, wx.cloud);   // overcast merges
      uniforms.uHaze.value = lerp(0.42, 0.62, wx.cloud);

      /* ---- resolve puff world positions ---- */
      active = 0;
      for (let i = 0; i < COUNT; i++) {
        const f = flat[i];
        const c = f.c, p = f.p;
        if (c.op < 0.015) { depth[i] = -1; continue; }
        /* slow reshape: each puff breathes and the cluster shears a
           little with the wind, so a cloud is never the same shape
           twice */
        const br = 1 + Math.sin(elapsed * p.bs + p.bp) * 0.11;
        const shear = Math.sin(elapsed * 0.045 + c.thr * 9.0) * 0.14;
        const i3 = i * 3;
        wpos[i3] = c.x + p.ox * br + p.oy * shear;
        wpos[i3 + 1] = c.y + p.oy * br;
        wpos[i3 + 2] = c.z + p.oz * br;
        const dx = wpos[i3] - cp.x, dy = wpos[i3 + 1] - cp.y, dz = wpos[i3 + 2] - cp.z;
        depth[i] = dx * dx + dy * dy + dz * dz;
        active++;
      }

      /* ---- back-to-front sort, a few times a second ---- */
      sortT -= dt;
      if (sortT <= 0) {
        sortT = 0.12;
        const live = [];
        for (let i = 0; i < COUNT; i++) if (depth[i] >= 0) live.push(i);
        live.sort((a, b) => depth[b] - depth[a]);
        for (let k = 0; k < live.length; k++) order[k] = live[k];
        active = live.length;
      } else {
        /* between sorts keep the previous order but drop anything
           that faded out */
        let w = 0;
        for (let k = 0; k < COUNT; k++) {
          const i = order[k];
          if (i >= 0 && i < COUNT && depth[i] >= 0) order[w++] = i;
        }
        active = w;
      }

      /* ---- write the instance buffer ---- */
      const pa = aPos.array, da = aData.array, ca = aCloud.array;
      for (let k = 0; k < active; k++) {
        const i = order[k];
        const f = flat[i];
        const c = f.c, p = f.p;
        const i3 = i * 3, k3 = k * 3, k4 = k * 4;
        pa[k3] = wpos[i3]; pa[k3 + 1] = wpos[i3 + 1]; pa[k3 + 2] = wpos[i3 + 2];
        da[k4] = p.r; da[k4 + 1] = p.seed; da[k4 + 2] = p.h01; da[k4 + 3] = c.op;
        ca[k4] = c.x; ca[k4 + 1] = c.y + c.H * 0.35; ca[k4 + 2] = c.z; ca[k4 + 3] = c.R;
      }
      if (active > 0) {
        aPos.needsUpdate = true;
        aData.needsUpdate = true;
        aCloud.needsUpdate = true;
      }
      geo.instanceCount = active;
      mesh.visible = active > 0;

      occSmooth = damp(occSmooth, sunOcclusion(cp, sunDir), 1.4, dt);
    },

    dispose() {
      ctx.scene.remove(mesh);
      geo.dispose();
      quad.dispose();
      mat.dispose();
    },
  };

  return api;
}
