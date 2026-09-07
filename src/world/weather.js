/* ============================================================
   weather.js — clear / cloudy / rain / storm, and the wet signal.
   THOSE FOUR AND NO OTHERS. There is no `overcast`; cloudy is the
   name for it. See WEATHER_NAMES below.

   Two rules from the brief shape everything here:

   * "Transitions take minutes, never snap." So a weather change does
     not switch a mode — it moves a *target* vector, and every scalar
     the rest of the sky reads is damped toward it. The default fade
     is 150 s. Nothing in the frame changes discontinuously, ever,
     including the cloud count (clouds fade in one by one, see
     clouds.js) and the wind strength.

   * "rain (exposing a wet-surface signal other modules can read)".
     `ctx.sky.wetness` is a 0..1 scalar and `ctx.sky.uniforms.uWetness`
     is a shared uniform object any material can bind by reference —
     the same pattern wind.js uses. It rises over ~35 s of rain and
     dries over ~4 minutes, because a city that dries the instant the
     rain stops reads as a toggle.

   Rain itself is one instanced draw of view-space streaks in a box
   that travels with the camera, slanted by the global wind field so
   it gusts with everything else (§2.3).
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { SEA } from '../core/palette.js';
import { clamp, smoothstep, damp } from '../core/contracts.js';

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const C_FOAM = srgb(SEA.foam);

/* Each preset is a *target*, never a state. Every field is damped. */
export const WEATHER = {
  clear: {
    cloud: 0.44, sunMul: 1.00, ambMul: 1.00, fogMul: 0.00,
    storm: 0.00, rain: 0.00, wet: 0.00, windMul: 1.00, exposureMul: 1.00,
  },
  cloudy: {
    cloud: 0.82, sunMul: 0.70, ambMul: 1.12, fogMul: 0.18,
    storm: 0.10, rain: 0.00, wet: 0.00, windMul: 1.18, exposureMul: 0.97,
  },
  rain: {
    cloud: 0.96, sunMul: 0.32, ambMul: 1.06, fogMul: 0.55,
    storm: 0.42, rain: 0.78, wet: 1.00, windMul: 1.40, exposureMul: 0.90,
  },
  storm: {
    cloud: 1.00, sunMul: 0.18, ambMul: 0.90, fogMul: 0.80,
    storm: 1.00, rain: 1.00, wet: 1.00, windMul: 1.95, exposureMul: 0.84,
  },
};

const KEYS = ['cloud', 'sunMul', 'ambMul', 'fogMul', 'storm', 'rain', 'wet', 'windMul', 'exposureMul'];

/* THE FOUR NAMES, EXPORTED, AND WHY THAT IS WORTH A LINE.
   tools/_sky-minute.mjs documented its weather axis as "storm |
   overcast | clear" for its whole life. There is no `overcast` state
   here, set() returned false for it, and the rig ignored the false
   and screenshotted a CLEAR sky under an OVERCAST heading — the ninth
   instrument on this project found reporting something other than
   what it measured. set() now says so out loud as well as returning
   false, and the list is exported so a rig can name its axis from the
   authority rather than from a comment. */
export const WEATHER_NAMES = Object.keys(WEATHER);

/* ------------------------------------------------------------------
   Rain — instanced view-space streaks.
   ------------------------------------------------------------------ */
function createRain(ctx) {
  const q = ctx.quality;
  const N = Math.max(240, Math.round(1500 * (q.particles ?? 1)));
  const rng = ctx.makeRng('sky.rain');

  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);

  const seeds = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) seeds[i] = rng();
  geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 3));
  geo.instanceCount = N;

  const uniforms = {
    uOrigin: { value: new THREE.Vector3() },
    uBox:    { value: new THREE.Vector3(26, 20, 26) },
    uWind:   { value: new THREE.Vector2(0.8, 0.5) },
    uColor:  { value: srgb(SEA.foam) },
    uTime:   { value: 0 },
    uSpeed:  { value: 1.35 },
    uAmount: { value: 0 },
    uLen:    { value: 0.85 },
    uWide:   { value: 0.018 },
    uSlant:  { value: 0.42 },
  };

  const mat = new THREE.ShaderMaterial({
    name: 'sky.rain',
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */`
      attribute vec3 iSeed;
      uniform vec3  uOrigin, uBox;
      uniform vec2  uWind;
      uniform float uTime, uSpeed, uLen, uWide, uSlant, uAmount;
      varying vec2  vUv;
      varying float vFade;

      void main() {
        /* One drop's whole life is a fract(): no CPU simulation, no
           buffer upload, and it wraps for free. */
        float jitter = 0.85 + 0.35 * iSeed.x;
        float fall = fract( iSeed.z * 7.13 + uTime * uSpeed * jitter );

        vec3 wp;
        wp.x = uOrigin.x + ( iSeed.x - 0.5 ) * uBox.x;
        wp.z = uOrigin.z + ( iSeed.y - 0.5 ) * uBox.z;
        wp.y = uOrigin.y + uBox.y * 0.62 - fall * uBox.y;
        wp.xz += uWind * ( fall * uSlant * uBox.y * 0.25 );

        /* the streak points along the drop's own velocity, which is
           down plus the wind — so rain leans with every other windy
           thing in the frame */
        vec3 vel = normalize( vec3( uWind.x * uSlant, -1.0, uWind.y * uSlant ) );

        vec4 mv = viewMatrix * vec4( wp, 1.0 );
        vec3 velView = ( viewMatrix * vec4( vel, 0.0 ) ).xyz;
        vec2 dir = normalize( velView.xy + vec2( 1e-5, 1e-5 ) );
        vec2 perp = vec2( -dir.y, dir.x );

        float len = uLen * ( 0.7 + 0.7 * iSeed.y );
        mv.xy += dir * ( position.y * len ) + perp * ( position.x * uWide );

        vUv = uv;
        /* cull the volume's own edges and anything right on the lens */
        float d = length( wp - uOrigin );
        vFade = uAmount
              * smoothstep( 0.9, 2.4, d )
              * ( 1.0 - smoothstep( uBox.x * 0.34, uBox.x * 0.52, d ) );

        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        if ( vFade < 0.004 ) discard;
        /* soft across, tapered along: a streak, not a rectangle */
        float across = 1.0 - abs( vUv.x * 2.0 - 1.0 );
        float along = sin( vUv.y * 3.14159 );
        float a = across * across * pow( along, 0.55 ) * vFade * 0.55;
        gl_FragColor = vec4( uColor, a );
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky.rain';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 9000;
  mesh.visible = false;
  mesh.userData.noPrepass = true;
  mesh.userData.noOutline = true;
  ctx.scene.add(mesh);

  return {
    mesh, uniforms,
    update(dt, amount, colors) {
      uniforms.uAmount.value = amount;
      mesh.visible = amount > 0.004;
      if (!mesh.visible) return;
      uniforms.uTime.value = ctx.elapsed;
      const cam = ctx.camera;
      if (cam) uniforms.uOrigin.value.copy(cam.position);
      const wd = ctx.wind?.uniforms?.uWindDir?.value;
      const ws = ctx.wind ? ctx.wind.strength : 0.4;
      if (wd) uniforms.uWind.value.set(wd.x, wd.y);
      uniforms.uSlant.value = 0.22 + ws * 0.75;
      uniforms.uSpeed.value = 1.15 + amount * 0.75;
      /* rain is lit by the sky, so it is never white at dusk */
      uniforms.uColor.value.copy(colors.horizonColor).lerp(C_FOAM, 0.55);
    },
    dispose() {
      ctx.scene.remove(mesh);
      geo.dispose(); quad.dispose(); mat.dispose();
    },
  };
}

/* ==================================================================
   createWeather
   ================================================================== */
export function createWeather(ctx) {
  const rain = createRain(ctx);

  const state = { ...WEATHER.clear, flash: 0 };
  const target = { ...WEATHER.clear };
  let name = 'clear';
  let fromName = 'clear';
  let lambda = 4 / 150;               // ~150 s to settle

  /* HOW FAR ALONG THE CHANGE IS — 0 at the set(), 1 once it has landed.

     It is NOT a second integrator. It is damped with the SAME lambda in
     the SAME update() as every field in KEYS, so it is by construction
     the curve the cloud count, the fog and the rain amount are already
     riding, and it cannot report a transition the sky is not making.

     It exists because a second subsystem — the soundscape — has to
     arrive and leave WITH the sky rather than switch on the event, and
     the alternative was audio.js damping a private copy over its own
     idea of the fade. Two integrators that agree today are two that can
     disagree after one edit. One scalar, read by everyone, cannot.
     Published as ctx.sky.weatherProgress. */
  let progress = 1;

  /* wetness is deliberately NOT the preset's `wet` — it has its own,
     much slower integrator so puddles outlive the shower */
  let wetness = 0;
  const uWetness = { value: 0 };

  /* lightning */
  let strikeIn = 6 + ctx.rng() * 10;
  let flashT = 0, flashLen = 0, flashPeak = 0;

  const api = {
    rain,
    state,
    uniforms: { uWetness },
    get name() { return name; },
    /* the state we are travelling FROM. Together with `name` and
       `progress` this is the whole transition, which is what a listener
       needs to blend anything of its own across it. */
    get from() { return fromName; },
    get progress() { return progress; },
    get wetness() { return wetness; },

    /* fade is in SECONDS. 0 snaps (debug only). */
    set(nameIn, fade = 150) {
      const preset = WEATHER[nameIn];
      if (!preset) {
        console.warn(`[weather] unknown state "${nameIn}" — weather.js authors ` +
          `${WEATHER_NAMES.join(', ')}. NOTHING CHANGED; the sky is still "${name}". ` +
          `A caller that ignores this false is measuring the previous state.`);
        return false;
      }
      fromName = name;
      name = nameIn;
      for (const k of KEYS) target[k] = preset[k];
      if (fade <= 0) {
        for (const k of KEYS) state[k] = preset[k];
        wetness = preset.wet;
        lambda = 4 / 150;
        progress = 1;
      } else {
        lambda = 4 / Math.max(0.5, fade);
        progress = 0;
      }
      /* `from` and `progress` ride along so a listener that arrives
         between two frames can blend the transition rather than snap to
         the end of it. Note the CHANNEL: this is `weather`, in the
         world's own namespace — there is no `audio:weather` emitter
         anywhere and there never was, which is how rain shipped silent.
         See the bus wiring in src/audio/audio.js. */
      ctx.bus.emit('weather', {
        name, from: fromName, fade, progress, target: { ...target },
      });
      return true;
    },

    update(dt, colors) {
      for (const k of KEYS) state[k] = damp(state[k], target[k], lambda, dt);
      /* same lambda, same frame, same law — see the note on `progress`.
         damp() is asymptotic, so it is snapped at the top or a listener
         reading `progress === 1` would wait forever. */
      if (progress < 1) {
        const p = damp(progress, 1, lambda, dt);
        progress = p > 0.9995 ? 1 : p;
      }

      /* --- wetness: soaks in fast-ish, dries slowly --- */
      const wetTarget = clamp(state.rain * 1.4, 0, 1);
      const wl = wetTarget > wetness ? 4 / 35 : 4 / 240;
      wetness = damp(wetness, wetTarget, wl, dt);
      uWetness.value = wetness;

      /* --- lightning (storm only) --- */
      if (state.storm > 0.55) {
        strikeIn -= dt * (0.4 + state.storm);
        if (strikeIn <= 0) {
          strikeIn = 4 + ctx.rng() * 14;
          flashLen = 0.30 + ctx.rng() * 0.22;
          flashT = flashLen;
          flashPeak = 0.55 + ctx.rng() * 0.75;
          /* audio can schedule the thunder itself; distance is
             whatever it likes, we just say how big the flash was */
          ctx.bus.emit('sky:lightning', { intensity: flashPeak, delay: 0.6 + ctx.rng() * 3.4 });
        }
      } else {
        strikeIn = 5 + ctx.rng() * 12;
      }

      if (flashT > 0) {
        flashT -= dt;
        const p = 1 - flashT / flashLen;
        /* a strike is not one flash — it is a stutter, and the
           stutter is the whole reason it reads as lightning */
        const env = Math.exp(-p * 7.0) * (0.55 + 0.45 * Math.abs(Math.sin(p * 19.0)));
        state.flash = flashPeak * env * smoothstep(0, 0.04, p);
      } else {
        state.flash = damp(state.flash, 0, 8, dt);
      }

      /* --- everything gusts together (§2.3) --- */
      if (ctx.wind?.setStrength) {
        const base = 0.42 * state.windMul;
        ctx.wind.setStrength(damp(ctx.wind.uniforms.uWindStrength.value, base, 0.4, dt));
      }

      rain.update(dt, state.rain, colors);
      return state;
    },

    dispose() { rain.dispose(); },
  };

  return api;
}
