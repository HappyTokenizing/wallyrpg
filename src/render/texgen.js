/* ============================================================
   texgen.js — procedural texture generation.

   No external assets, ever (BUILD_BRIEF). Everything the material
   layer needs is synthesised here at boot from a seeded RNG, so two
   builds produce byte-identical textures and screenshots are
   comparable.

   Noise is tileable by construction: the value-noise lattice is
   hashed modulo the period, and every octave doubles the period, so
   an N-octave fBm still wraps exactly at the texture edge. That
   matters — a seam in the clay grain would be visible on Wally's
   cheek from three metres away.

   Everything returns a THREE.DataTexture (or CanvasTexture for the
   hand-drawn shapes) with repeat wrapping and mipmaps.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';

/* ---------- deterministic lattice noise ---------- */

function latHash(ix, iy, period, seed) {
  /* wrap into the period so the field tiles */
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ x, 0x85ebca6b);
  h = Math.imul(h ^ y, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

function vnoise2(x, y, period, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const a = latHash(ix, iy, period, seed);
  const b = latHash(ix + 1, iy, period, seed);
  const c = latHash(ix, iy + 1, period, seed);
  const d = latHash(ix + 1, iy + 1, period, seed);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

/* Tileable fBm over a texture of `size` px with `base` lattice cells. */
function fbm2(u, v, base, octaves, seed, gain = 0.5, ridged = false) {
  let f = base, amp = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    let n = vnoise2(u * f, v * f, f, seed + o * 7919);
    if (ridged) n = 1 - Math.abs(n * 2 - 1);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/* ---------- texture helpers ---------- */

function dataTex(size, rgba, { srgb = false, aniso = 4, mips = true } = {}) {
  const t = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/* Height field -> tangent-space normal, wrapping at the edges. */
function heightToNormal(size, height, strength, out, ox = 0, scaleZ = 1) {
  const w = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (w(x + 1, y) - w(x - 1, y)) * strength;
      const dy = (w(x, y + 1) - w(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1 / scaleZ;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      out[i + ox] = Math.round((nx / l * 0.5 + 0.5) * 255);
      out[i + ox + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
    }
  }
}

/* ============================================================
   The generators
   ============================================================ */

export function createTexGen(ctx) {
  const aniso = ctx?.quality?.anisotropy ?? 4;
  const cache = new Map();
  const owned = [];

  function keep(t) { owned.push(t); return t; }
  function memo(key, fn) {
    if (!cache.has(key)) cache.set(key, keep(fn()));
    return cache.get(key);
  }

  const api = {
    /* ---- the velvet grain (ART_DIRECTION §1.2) ----------------
       A tangent-space normal map of very fine, slightly clumped
       noise. RGB = normal xy + a luminance jitter in B that the
       shader uses for micro-albedo variation. This is the single
       texture that makes clay read as clay. */
    grain(size = 256, cells = 48, strength = 26) {
      return memo(`grain:${size}:${cells}:${strength}`, () => {
        const h = new Float32Array(size * size);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const u = x / size, v = y / size;
            /* two scales: a fine pore field plus a slow clumping so
               the grain has structure rather than looking like TV snow */
            const fine = fbm2(u, v, cells, 3, 0x51a3, 0.45);
            const clump = fbm2(u, v, Math.max(4, cells >> 3), 2, 0x77b1, 0.5);
            h[y * size + x] = fine * (0.62 + 0.55 * clump);
          }
        }
        const px = new Uint8Array(size * size * 4);
        heightToNormal(size, h, strength, px, 0);
        for (let i = 0; i < size * size; i++) {
          px[i * 4 + 2] = Math.round(h[i] * 255);       // micro albedo
          px[i * 4 + 3] = 255;
        }
        return dataTex(size, px, { aniso });
      });
    },

    /* ---- 4-band packed noise ----------------------------------
       R fine, G medium, B coarse, A ridged. One fetch gives the
       material layer every frequency it needs for blotching,
       chipping, dirt and colour variation. */
    packed(size = 256) {
      return memo(`packed:${size}`, () => {
        const px = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const u = x / size, v = y / size;
            const i = (y * size + x) * 4;
            px[i]     = Math.round(fbm2(u, v, 32, 3, 0x1234, 0.5) * 255);
            px[i + 1] = Math.round(fbm2(u, v, 8,  3, 0x2345, 0.55) * 255);
            px[i + 2] = Math.round(fbm2(u, v, 3,  3, 0x3456, 0.6) * 255);
            px[i + 3] = Math.round(fbm2(u, v, 12, 3, 0x4567, 0.5, true) * 255);
          }
        }
        return dataTex(size, px, { aniso });
      });
    },

    /* ---- weathered wood ---------------------------------------
       U runs across the grain, V along it. R = albedo multiplier
       (dark late-wood streaks), GB = normal xy so the planks catch
       the key light along the grain. */
    wood(size = 256) {
      return memo(`wood:${size}`, () => {
        const h = new Float32Array(size * size);
        const alb = new Float32Array(size * size);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const u = x / size, v = y / size;
            /* stretch the lattice heavily along V: 24 cells across,
               ~3 along, which is what makes it read as grain and not
               as generic noise */
            let g = vnoise2(u * 24, v * 3, 24, 0x8a11) * 0.6
                  + vnoise2(u * 48, v * 6, 48, 0x8a12) * 0.28
                  + vnoise2(u * 96, v * 12, 96, 0x8a13) * 0.12;
            /* rings: bands of late wood */
            const rings = Math.abs(Math.sin((u * 9.0 + g * 2.6) * Math.PI));
            const knot = fbm2(u, v, 4, 2, 0x8a20, 0.5);
            const t = rings * 0.72 + g * 0.28;
            alb[y * size + x] = 0.74 + 0.26 * t + 0.09 * knot;
            h[y * size + x] = t * 0.85 + knot * 0.15;
          }
        }
        const px = new Uint8Array(size * size * 4);
        heightToNormal(size, h, 10, px, 1);   // write normal into G,B
        for (let i = 0; i < size * size; i++) {
          px[i * 4] = Math.max(0, Math.min(255, Math.round(alb[i] * 190)));
          px[i * 4 + 3] = 255;
        }
        return dataTex(size, px, { aniso });
      });
    },

    /* ---- plaster ---------------------------------------------
       Blotchy colour variation plus a shallow stucco relief. R =
       blotch, GB = normal xy, A = chip mask (where the paint has
       worn back to a lighter substrate). */
    plaster(size = 256) {
      return memo(`plaster:${size}`, () => {
        const h = new Float32Array(size * size);
        const px = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const u = x / size, v = y / size;
            const i = (y * size + x) * 4;
            const blot = fbm2(u, v, 5, 3, 0xbb01, 0.58);
            const stucco = fbm2(u, v, 40, 3, 0xbb02, 0.5);
            const chip = fbm2(u, v, 14, 3, 0xbb03, 0.5, true);
            h[y * size + x] = stucco * 0.75 + blot * 0.25;
            px[i] = Math.round(blot * 255);
            px[i + 3] = Math.round(Math.max(0, chip - 0.62) / 0.38 * 255);
          }
        }
        heightToNormal(size, h, 14, px, 1);
        return dataTex(size, px, { aniso });
      });
    },

    /* ---- a leaf card -------------------------------------------
       Alpha-tested foliage needs a silhouette that is not a quad.
       Hand-drawn on a canvas: a cluster of five rounded leaflets
       with a slight colour break between them (RGB), alpha in A. */
    leaf(size = 256) {
      return memo(`leaf:${size}`, () => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d');
        g.clearRect(0, 0, size, size);
        const rng = ctx?.makeRng ? ctx.makeRng('leafcard') : Math.random;
        const S = size / 256;

        const leaflet = (cx, cy, w, hgt, rot, shade) => {
          g.save();
          g.translate(cx, cy);
          g.rotate(rot);
          const grad = g.createLinearGradient(0, -hgt, 0, hgt);
          const a = Math.round(210 + shade * 45);
          grad.addColorStop(0, `rgba(${a},${a},${a},1)`);
          grad.addColorStop(1, `rgba(${a * 0.72 | 0},${a * 0.72 | 0},${a * 0.72 | 0},1)`);
          g.fillStyle = grad;
          g.beginPath();
          g.moveTo(0, -hgt);
          g.bezierCurveTo(w, -hgt * 0.45, w * 0.86, hgt * 0.5, 0, hgt);
          g.bezierCurveTo(-w * 0.86, hgt * 0.5, -w, -hgt * 0.45, 0, -hgt);
          g.fill();
          /* midrib — a slightly darker spine so leaves aren't flat */
          g.strokeStyle = 'rgba(120,120,120,0.55)';
          g.lineWidth = 2 * S;
          g.beginPath(); g.moveTo(0, -hgt * 0.86); g.lineTo(0, hgt * 0.82); g.stroke();
          g.restore();
        };

        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + 0.4;
          const r = (46 + rng() * 24) * S;
          leaflet(size * 0.5 + Math.cos(a) * r,
                  size * 0.5 + Math.sin(a) * r * 0.82,
                  (34 + rng() * 12) * S, (56 + rng() * 20) * S,
                  a + Math.PI * 0.5 + (rng() - 0.5) * 0.5,
                  rng());
        }
        leaflet(size * 0.5, size * 0.5, 40 * S, 66 * S, 0.15, 0.9);

        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = aniso;
        t.colorSpace = THREE.NoColorSpace;
        t.needsUpdate = true;
        return t;
      });
    },

    /* ---- blue-ish dither / rotation texture -------------------- */
    dither(size = 64) {
      return memo(`dither:${size}`, () => {
        const px = new Uint8Array(size * size * 4);
        const rng = ctx?.makeRng ? ctx.makeRng('dither') : Math.random;
        for (let i = 0; i < size * size; i++) {
          px[i * 4] = (rng() * 256) | 0;
          px[i * 4 + 1] = (rng() * 256) | 0;
          px[i * 4 + 2] = (rng() * 256) | 0;
          px[i * 4 + 3] = 255;
        }
        const t = dataTex(size, px, { aniso: 1, mips: false });
        t.magFilter = t.minFilter = THREE.NearestFilter;
        return t;
      });
    },

    /* ---- a 1D toon ramp, if a material wants an explicit LUT --- */
    ramp(stops, width = 64) {
      const key = 'ramp:' + stops.map(s => s[0].toFixed(2) + ':' + s[1].toString(16)).join(',');
      return memo(key, () => {
        const px = new Uint8Array(width * width * 4);
        const col = new THREE.Color();
        for (let x = 0; x < width; x++) {
          const t = x / (width - 1);
          let lo = stops[0], hi = stops[stops.length - 1];
          for (let i = 0; i < stops.length - 1; i++) {
            if (t >= stops[i][0] && t <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
          }
          const k = hi[0] === lo[0] ? 0 : (t - lo[0]) / (hi[0] - lo[0]);
          const a = new THREE.Color().setHex(lo[1], THREE.SRGBColorSpace);
          const b = new THREE.Color().setHex(hi[1], THREE.SRGBColorSpace);
          col.copy(a).lerp(b, k);
          for (let y = 0; y < width; y++) {
            const i = (y * width + x) * 4;
            px[i] = col.r * 255; px[i + 1] = col.g * 255; px[i + 2] = col.b * 255; px[i + 3] = 255;
          }
        }
        const t2 = dataTex(width, px, { aniso: 1, mips: false });
        t2.wrapS = t2.wrapT = THREE.ClampToEdgeWrapping;
        return t2;
      });
    },

    dispose() {
      for (const t of owned) t.dispose();
      owned.length = 0;
      cache.clear();
    },
  };

  return api;
}
