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

  /* ============================================================
     THE PIN — the control every frame measurement in this project
     did not have.

     setStrength(0) DOES NOT BECALM THE AIR and never did. Three
     independent writers move this field every frame:
       1. weather.js:329 damps uWindStrength back toward 0.42*windMul
          EVERY FRAME, so a base written to 0 is most of the way home
          within a second and nominal within three;
       2. the gust machine below writes uWindGust on its own clock,
          and setStrength does not touch that term at all;
       3. the direction wander re-aims uWindDir every 18-40 s.
     Measured here: mean total wind after "becalming" 0.4477 against a
     nominal 0.42 — indistinguishable from not calling it. In one
     balloon A/B the BECALMED arm read |wind| 0.531 and the DRIFTING
     arm 0.457: the two arms were the same condition with the labels
     swapped.

     pin() holds BOTH terms and the direction, refuses setStrength()
     and setDirection() while held, and skips the whole state machine
     in update(). uTime keeps advancing — every material in the world
     shares it, and freezing it would freeze the frame, not the wind —
     so what the pin makes constant is the AMPLITUDE:

         wind.strength          exactly the pinned base + gust
         wind.sample(x,z,ph)    that amplitude times a fixed wave
         wind.vector(x,z)       fixed bearing, bounded magnitude

     At pin(0) both terms are zero, so sample() and vector() are
     IDENTICALLY ZERO at every point and every frame — an exact
     becalm, not a mean. That is the arm an A/B wants.

     HOW A LATER AGENT USES IT (replaces the setStrength(0) idiom in
     every rig in tools/):
         WALLY.ctx.wind.pin(0);       // becalm, exactly and durably
         ... measure the frame ...
         WALLY.ctx.wind.unpin();      // weather takes the field back
     For a known wind on a known bearing, pin the whole state at once
     rather than setStrength + setDirection — setDirection only EASES
     toward its target over seconds, while pin snaps and holds:
         WALLY.ctx.wind.pin({ strength: 1.0, gust: 0, dir: Math.atan2(dz, dx) });
     pin() with no argument freezes whatever is blowing right now,
     which is how you hold one arm's conditions across a switch.
     wind.pinned reads back the held state, or null.
     ============================================================ */
  let pinned = null;          // null, or { strength, gust, dir }

  function applyPin() {
    uniforms.uWindStrength.value = pinned.strength;
    uniforms.uWindGust.value     = pinned.gust;
    dirAngle = dirTarget = pinned.dir;
    uniforms.uWindDir.value.set(Math.cos(dirAngle), Math.sin(dirAngle));
  }

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

    /* Both setters REFUSE non-finite input and REFUSE to move a pinned
       field, and both return the value now in force, so the no-argument
       call reads instead of corrupting. weather.js calls setStrength
       every frame; that call is the thing the pin has to block, and
       this is the only line that can block it. */
    setStrength(v) {
      if (pinned || !Number.isFinite(v)) return uniforms.uWindStrength.value;
      uniforms.uWindStrength.value = v;
      return v;
    },
    setDirection(rad) {
      if (pinned || !Number.isFinite(rad)) return dirTarget;
      dirTarget = rad;
      return rad;
    },

    /** Hold the delivered wind. See THE PIN above. Returns the held state. */
    pin(v) {
      const cur = {
        strength: uniforms.uWindStrength.value,
        gust:     uniforms.uWindGust.value,
        dir:      dirAngle,
      };
      if (typeof v === 'number') {
        pinned = Number.isFinite(v) ? { strength: v, gust: 0, dir: cur.dir } : cur;
      } else if (v && typeof v === 'object') {
        pinned = {
          strength: Number.isFinite(v.strength) ? v.strength : cur.strength,
          gust:     Number.isFinite(v.gust)     ? v.gust     : 0,
          dir:      Number.isFinite(v.dir)      ? v.dir      : cur.dir,
        };
      } else {
        pinned = cur;                       // pin() — hold what is blowing
      }
      applyPin();
      return { ...pinned };
    },

    /** Release the field back to weather.js and the gust machine. */
    unpin() {
      const was = pinned;
      pinned = null;
      return was ? { ...was } : null;
    },

    /** The held state, or null. Print this beside any pinned number. */
    get pinned() { return pinned ? { ...pinned } : null; },

    update(dt, elapsed) {
      uniforms.uTime.value = elapsed;

      /* PINNED: no wander, no gust, and weather.js's write was refused
         at the setter. uTime still advances — see THE PIN. */
      if (pinned) {
        applyPin();
        ctx.bus.emit('wind', api);
        return;
      }

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
