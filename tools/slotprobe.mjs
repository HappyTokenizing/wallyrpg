#!/usr/bin/env node
/* ============================================================
   slotprobe.mjs — THE FAST ARM-SLOT PROBE (bind pose, no browser).

   Meshes the real body field with the real surface-nets cell, then
   rasterises the resulting triangles' silhouette into a screen-space
   mask along the CAMS.studio view direction (orthographic — the studio
   lens is 33 degrees at 3.3 m, so perspective moves the slot by under a
   millimetre and this is a ruler, not a render). Then it counts
   interior background runs exactly the way tools/armslot.mjs does on a
   real magenta frame.

   Two numbers per row, because both matter and they are NOT the same:
     FRONT  — the slot as seen square-on (what the field authoring is
              actually controlling)
     3/4    — the slot as seen from CAMS.studio, i.e. the acceptance test

   The bind pose is not the cool pose: `cool` rolls the shoulders 3
   degrees and the hips 2.8, which moves the wrist by ~20 mm. So this is
   a SEARCH tool. Every number reported to anyone comes from a real
   magenta frame through tools/armslot.mjs.

   Usage: node tools/slotprobe.mjs [--deg 28.9] [--tier high]
   ============================================================ */
import { buildBodyField, surfaceNets } from '../src/character/model.js';

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; }
const DEG = +arg('deg', null) || Math.atan2(1.60, 2.90 - 0.01) * 180 / Math.PI;  // CAMS.studio
const CELL = { low: 0.0200, med: 0.0168, high: 0.0136, ultra: 0.0124 }[arg('tier', 'high')];

const t0 = Date.now();
const field = buildBodyField();
const mesh = surfaceNets(field.d, field.bounds, CELL);
const meshMs = Date.now() - t0;

/* --- rasterise the silhouette --- */
const PX = 0.002;              // 2 mm mask pixels — 7x finer than the cell
const H = 1.60;

function mask(deg) {
  const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
  const pos = mesh.position, idx = mesh.index;
  const U0 = -0.80, U1 = 0.80, Y0 = 0.0, Y1 = 1.75;
  const W = Math.round((U1 - U0) / PX), Hh = Math.round((Y1 - Y0) / PX);
  const m = new Uint8Array(W * Hh);
  for (let i = 0; i < idx.length; i += 3) {
    let ux = 0, uy = 0, lo = 1e9, hi = -1e9, lv = 1e9, hv = -1e9;
    const u = [0, 0, 0], v = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const j = idx[i + k] * 3;
      u[k] = c * pos[j] - s * pos[j + 2];
      v[k] = pos[j + 1];
      if (u[k] < lo) lo = u[k]; if (u[k] > hi) hi = u[k];
      if (v[k] < lv) lv = v[k]; if (v[k] > hv) hv = v[k];
    }
    const x0 = Math.max(0, Math.floor((lo - U0) / PX)), x1 = Math.min(W - 1, Math.ceil((hi - U0) / PX));
    const y0 = Math.max(0, Math.floor((lv - Y0) / PX)), y1 = Math.min(Hh - 1, Math.ceil((hv - Y0) / PX));
    if (x1 < x0 || y1 < y0) continue;
    const d = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0]);
    if (d === 0) continue;
    for (let py = y0; py <= y1; py++) {
      const yy = Y0 + (py + 0.5) * PX;
      for (let px = x0; px <= x1; px++) {
        const xx = U0 + (px + 0.5) * PX;
        const w0 = ((u[1] - xx) * (v[2] - yy) - (u[2] - xx) * (v[1] - yy)) / d;
        const w1 = ((u[2] - xx) * (v[0] - yy) - (u[0] - xx) * (v[2] - yy)) / d;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) m[py * W + px] = 1;
      }
    }
  }
  return { m, W, Hh, U0, Y0 };
}

function rows(mk) {
  const { m, W, Hh, U0, Y0 } = mk;
  let top = -1, bot = -1;
  for (let y = 0; y < Hh; y++) { let a = 0; for (let x = 0; x < W; x++) if (m[y * W + x]) { a = 1; break; } if (a) { if (bot < 0) bot = y; top = y; } }
  const out = [];
  for (let f = 0.33; f <= 0.601; f += 0.03) {
    const y = Math.round(top - f * (top - bot));
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) if (m[y * W + x]) { if (l < 0) l = x; r = x; }
    const runs = []; let st = -1;
    for (let x = l; x <= r; x++) {
      const bg = !m[y * W + x];
      if (bg && st < 0) st = x;
      if (!bg && st >= 0) { if (x - st >= 2) runs.push([st, x - 1]); st = -1; }
    }
    const cx = (l + r) / 2;
    const U = (px) => (U0 + px * PX) * 1000;      // mm from the body's own x = 0
    out.push({
      f, yw: (Y0 + y * PX), lo: U(l), hi: U(r),
      runs: runs.map(([a, b]) => ({
        mm: (b - a + 1) * PX * 1000,
        side: (a + b) / 2 < cx ? 'L' : 'R',
        at: U((a + b) / 2),                        // slot centre, mm
        torso: (a + b) / 2 < cx ? U(b) : U(a),     // the torso-side edge
      })),
    });
  }
  return out;
}

const fr = rows(mask(0)), tq = rows(mask(DEG));
console.log(`cell ${(CELL * 1000).toFixed(1)} mm   mesh ${(mesh.count)} verts / ${mesh.index.length / 3} tris   ${meshMs} ms   studio angle ${DEG.toFixed(1)} deg`);
const fmt = (r) => '[' + r.runs.map(x => `${x.side}:${x.mm.toFixed(0)}@${x.at.toFixed(0)}`).join(' ') + ']';
let ok = 0;
for (let i = 0; i < fr.length; i++) {
  const good = tq[i].runs.length === 2 && tq[i].runs.every(x => x.mm >= 35) && tq[i].runs[0].side !== tq[i].runs[1].side;
  if (good) ok++;
  console.log(`f=${fr[i].f.toFixed(2)} y=${fr[i].yw.toFixed(3)}  FRONT ${fmt(fr[i]).padEnd(26)}out ${fr[i].hi.toFixed(0).padStart(4)}  |  3/4 ${fmt(tq[i]).padEnd(26)}out ${tq[i].hi.toFixed(0).padStart(4)}${good ? ' OK' : ''}`);
}
console.log(`${ok}/${fr.length} rows pass at the studio angle (bind pose).`);
