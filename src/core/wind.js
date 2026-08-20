/* ============================================================
   wind.js — the global wind field.

   Wind is the signature of this art direction (ART_DIRECTION §2.3):
   grass, canopies, banners, awnings, laundry, water, particles and
   Wally's ears all read the SAME uniforms, so when it gusts, the whole
   world gusts together.

   Any material that moves in the wind must include these uniforms by
   calling `ctx.wind.attach(material)` — never declare your own.

   Uniforms (all shared objects — mutate .value, never reassign):
     uTime          float   seconds
     uWindDir       vec2    normalised XZ direction
     uWindStrength  float   0..1 base strength
     uWindGust      float   0..1 current gust on top of base
     uWindFreq      float   spatial frequency of the travelling wave

   GLSL helper (inject with ctx.wind.glsl):
     float windWave(vec3 worldPos, float phase)
     vec3  windOffset(vec3 worldPos, float stiffness, float phase)
   ============================================================ */

import { damp, smoothstep } from './contracts.js';

export const WIND_GLSL = /* glsl */`
  uniform float uTime;
  uniform vec2  uWindDir;
  uniform float uWindStrength;
  uniform float uWindGust;
  uniform float uWindFreq;

  // A travelling wave along the wind direction, plus a slower cross
  // wave so gusts read as sheets moving across the field rather than
  // every blade doing the same thing.
  float windWave(vec3 wp, float phase) {
    float along = dot(wp.xz, uWindDir);
    float cross = dot(wp.xz, vec2(-uWindDir.y, uWindDir.x));
    float a = sin(along * uWindFreq - uTime * 2.4 + phase);
    float b = sin(cross * uWindFreq * 0.43 - uTime * 0.9 + phase * 1.7);
    float c = sin(along * uWindFreq * 2.9 - uTime * 5.1 + phase * 0.3) * 0.28;
    return (a * 0.62 + b * 0.3 + c) * (uWindStrength + uWindGust);
  }

  // Bend offset for a vertex, given a normalised height up the object.
  // Bend is quadratic in height so roots stay planted and tips whip.
  vec3 windOffset(vec3 wp, float stiffness, float phase) {
    float w = windWave(wp, phase);
    float bend = w * stiffness * stiffness;
    return vec3(uWindDir.x * bend, -abs(bend) * 0.18, uWindDir.y * bend);
  }
`;

export async function init(ctx) {
  const { THREE } = ctx;

  const uniforms = {
    uTime:         { value: 0 },
    uWindDir:      { value: new THREE.Vector2(0.82, 0.57).normalize() },
    uWindStrength: { value: 0.42 },
    uWindGust:     { value: 0 },
    uWindFreq:     { value: 0.34 },
  };

  /* Every wind-driven material registers here so a quality change or a
     shader rebuild can re-attach uniforms without hunting the scene. */
  const attached = new Set();

  /* Gust state machine: long calm stretches punctuated by a swell that
     builds over ~1.4 s, holds, and falls away over ~2.6 s. */
  let gustT = 0, gustLen = 0, gustPeak = 0, calmFor = 3.5;
  let dirAngle = Math.atan2(uniforms.uWindDir.value.y, uniforms.uWindDir.value.x);
  let dirTarget = dirAngle;
  let dirTimer = 0;

  const api = {
    uniforms,
    glsl: WIND_GLSL,

    /* Attach the shared uniforms to a material. Works for RawShaderMaterial,
       ShaderMaterial and anything patched via onBeforeCompile. */
    attach(material) {
      if (!material) return material;
      if (material.uniforms) {
        for (const k in uniforms) material.uniforms[k] = uniforms[k];
      } else {
        const prev = material.onBeforeCompile;
        material.onBeforeCompile = (shader, r) => {
          for (const k in uniforms) shader.uniforms[k] = uniforms[k];
          prev?.call(material, shader, r);
        };
      }
      attached.add(material);
      return material;
    },

    /* Sample the wind in JS — used by ear/trunk physics and particles. */
    sample(x, z, phase = 0) {
      const d = uniforms.uWindDir.value;
      const f = uniforms.uWindFreq.value;
      const t = uniforms.uTime.value;
      const along = x * d.x + z * d.y;
      const cross = -x * d.y + z * d.x;
      const a = Math.sin(along * f - t * 2.4 + phase);
      const b = Math.sin(cross * f * 0.43 - t * 0.9 + phase * 1.7);
      return (a * 0.62 + b * 0.3) * (uniforms.uWindStrength.value + uniforms.uWindGust.value);
    },

    /* Instantaneous wind vector in world XZ, for physics. */
    vector(x, z, out) {
      const s = api.sample(x, z);
      const d = uniforms.uWindDir.value;
      const m = (uniforms.uWindStrength.value + uniforms.uWindGust.value) * 0.6 + s * 0.4;
      if (out) return out.set(d.x * m, 0, d.y * m);
      return { x: d.x * m, y: 0, z: d.y * m };
    },

    get strength() { return uniforms.uWindStrength.value + uniforms.uWindGust.value; },
    setStrength(v) { uniforms.uWindStrength.value = v; },
    setDirection(rad) { dirTarget = rad; },

    update(dt, elapsed) {
      uniforms.uTime.value = elapsed;

      // Direction wanders slowly — a new target every 18-40 s, eased in.
      dirTimer -= dt;
      if (dirTimer <= 0) {
        dirTimer = 18 + ctx.rng() * 22;
        dirTarget = dirAngle + (ctx.rng() - 0.5) * 1.5;
      }
      dirAngle = damp(dirAngle, dirTarget, 0.35, dt);
      uniforms.uWindDir.value.set(Math.cos(dirAngle), Math.sin(dirAngle));

      // Gusts.
      if (calmFor > 0) {
        calmFor -= dt;
        uniforms.uWindGust.value = damp(uniforms.uWindGust.value, 0, 3, dt);
      } else if (gustT <= 0) {
        gustT = gustLen = 1.4 + ctx.rng() * 3.2;
        gustPeak = 0.18 + ctx.rng() * 0.42;
      } else {
        gustT -= dt;
        const p = 1 - gustT / gustLen;                       // 0..1 through the gust
        const env = smoothstep(0, 0.28, p) * (1 - smoothstep(0.55, 1, p));
        uniforms.uWindGust.value = gustPeak * env;
        if (gustT <= 0) calmFor = 2.5 + ctx.rng() * 6;
      }

      ctx.bus.emit('wind', api);
    },
  };

  return api;
}
