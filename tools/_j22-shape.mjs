#!/usr/bin/env node
/* ============================================================
   _j22-shape.mjs — ROUND 6 JUDGE, part 2. The SHAPE of the crossing,
   not its extremum, plus the two windows the brief protects.

   Three questions a peak/worst table cannot answer:

     1. HOW LONG is the pale window, in REAL seconds the player is
        sitting in front of? A chroma minimum of 0.056 lasting 0.4 s
        and one lasting 14 s are not the same defect, and every table
        in src/world/lighting.js reports the minimum.
     2. WHERE is the rate spent? warp's 62.7 c/s peak is one spike;
        ship's 12.1 is a plateau. "Would a player see it animate" is a
        question about the DWELL above a visibility threshold, not
        about the peak.
     3. Is the INTRO window untouched? intro.js runs HOUR0 6.05 to
        HOUR1 7.35 — 06:03 to 07:21 — which is NOT the window the
        round-5 comments protect, and the 07:00->10:00 deMud segment
        overlaps its last 21 minutes.

   Same sampler, same 0.05 in-game min = 0.1 real s grid, same process.
   ============================================================ */
import * as W from '../src/world/lighting.js';
import { sampleTOD as sampleHEAD } from '../src/world/_j22_head_lighting.js';
import { TIME_OF_DAY, SKY } from '../src/core/palette.js';
import * as THREE from '../vendor/three.module.js';

const mk = () => ({ sun: new THREE.Color(), amb: new THREE.Color(), sky: new THREE.Color(),
  horizon: new THREE.Color(), fog: new THREE.Color(), sunEl: 0, exposure: 0 });
const A = mk(), B = mk();
const g8 = (v) => 255 * Math.pow(Math.max(v, 0), 1 / 2.2);
const f8 = (c) => [g8(c.r), g8(c.g), g8(c.b)];
const chroma = (c) => { const [r, g, b] = f8(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx > 1e-4 ? (mx - mn) / mx : 0; };
const hexOf = (c) => '#' + f8(c).map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const dist = (x, y) => { const p = f8(x), q = f8(y); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const hhmmss = (m) => { const s = Math.round((m % 1) * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m) % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`; };
const ST = 0.05, SECS = 0.1;
const NAMES = ['head', 'prev', 'warp', 'ship'];
const S = (n) => n === 'head' ? ((h, o) => sampleHEAD(h, o)) : ((h, o) => { W.setSkyRule(n); return W.sampleTOD(h, o); });
const CROSS = [['morning', 7 * 60, 8 * 60 + 30], ['afternoon', 16 * 60 + 30, 18 * 60]];

console.log('rig: node ' + process.version + ' CPU, one process; 0.05 in-game min = 0.1 real s\n');

console.log('== 1. DWELL BELOW A CHROMA THRESHOLD, in REAL SECONDS (horizon) ==');
console.log('   the longest CONTIGUOUS run, and the total, inside each crossing window');
console.log('build  crossing    <0.20 run/tot   <0.15 run/tot   <0.10 run/tot   min chroma @');
for (const n of NAMES) {
  const s = S(n);
  for (const [lb, a, b] of CROSS) {
    const out = [];
    let mn = { c: 9, m: 0 };
    for (const th of [0.20, 0.15, 0.10]) {
      let run = 0, best = 0, tot = 0;
      for (let m = a; m < b; m += ST) {
        s(m / 60, A); const c = chroma(A.horizon);
        if (th === 0.20 && c < mn.c) mn = { c, m };
        if (c < th) { run += SECS; tot += SECS; if (run > best) best = run; } else run = 0;
      }
      out.push(`${best.toFixed(1).padStart(5)}/${tot.toFixed(1).padStart(5)}s`);
    }
    console.log(`${n.padEnd(6)} ${lb.padEnd(11)} ${out.join('   ')}   ${mn.c.toFixed(3)} @${hhmmss(mn.m)}`);
  }
}

console.log('\n== 2. RATE DWELL — real seconds the horizon moves FASTER than a threshold ==');
console.log('   (both crossing windows summed; 1 c/s over 2 s = 1 code per in-game minute)');
console.log('build  peak    mean   p95    >3 c/s   >6 c/s   >12 c/s  >25 c/s   total motion (codes)');
for (const n of NAMES) {
  const s = S(n);
  let all = [], pk = 0, sum = 0, cnt = 0, path = 0;
  const over = { 3: 0, 6: 0, 12: 0, 25: 0 };
  for (const [, a, b] of CROSS) {
    for (let m = a; m < b; m += ST) {
      s(m / 60, A); s((m + ST) / 60, B);
      const r = dist(A.horizon, B.horizon) / SECS;
      all.push(r); if (r > pk) pk = r; sum += r; cnt++; path += r * SECS;
      for (const t of [3, 6, 12, 25]) if (r > t) over[t] += SECS;
    }
  }
  all.sort((x, y) => x - y);
  console.log(`${n.padEnd(6)} ${pk.toFixed(1).padStart(6)} ${(sum / cnt).toFixed(2).padStart(6)} ` +
    `${all[Math.floor(all.length * 0.95)].toFixed(2).padStart(6)}  ` +
    `${over[3].toFixed(1).padStart(6)}s ${over[6].toFixed(1).padStart(7)}s ${over[12].toFixed(1).padStart(7)}s ` +
    `${over[25].toFixed(1).padStart(7)}s   ${path.toFixed(0).padStart(6)}`);
}

console.log('\n== 3. THE INTRO WINDOW, intro.js HOUR0 6.05 -> HOUR1 7.35 (06:03 -> 07:21) ==');
console.log('   max |d| vs HEAD in 8-bit codes over the whole window, plus the last frame');
console.log('build  sun   amb   sky   horizon  fog    | 07:21 horizon HEAD -> build          chroma');
for (const n of NAMES) {
  if (n === 'head') continue;
  let mx = { sun: 0, amb: 0, sky: 0, horizon: 0, fog: 0 }, at = 0;
  for (let m = 6.05 * 60; m <= 7.35 * 60; m += ST) {
    sampleHEAD(m / 60, A); W.setSkyRule(n); W.sampleTOD(m / 60, B);
    for (const k of ['sun', 'amb', 'sky', 'horizon', 'fog']) {
      const d = dist(A[k], B[k]);
      if (d > mx[k]) { mx[k] = d; if (k === 'horizon') at = m; }
    }
  }
  sampleHEAD(7.35, A); W.setSkyRule(n); W.sampleTOD(7.35, B);
  console.log(`${n.padEnd(6)} ${mx.sun.toFixed(2).padStart(5)} ${mx.amb.toFixed(2).padStart(5)} ${mx.sky.toFixed(2).padStart(5)} ` +
    `${mx.horizon.toFixed(2).padStart(7)} ${mx.fog.toFixed(2).padStart(6)} | ${hexOf(A.horizon)} -> ${hexOf(B.horizon)} ` +
    `  (peak d at ${hhmmss(at)})  ${chroma(A.horizon).toFixed(3)} -> ${chroma(B.horizon).toFixed(3)}`);
}
console.log(`   the authored peach, TIME_OF_DAY t=7 horizon = SKY.dawn = #${SKY.dawn.toString(16).toUpperCase()}`);
{
  sampleHEAD(7, A); console.log(`   at 07:00 exactly: HEAD ${hexOf(A.horizon)}`);
  for (const n of ['prev', 'warp', 'ship']) { W.setSkyRule(n); W.sampleTOD(7, B); console.log(`                     ${n.padEnd(4)} ${hexOf(B.horizon)}  (keyframes are reproduced exactly by construction)`); }
}

console.log('\n== 4. GREEN-SMALLEST (the magenta/lid tell) inside the crossings, in-game minutes ==');
for (const n of NAMES) {
  const s = S(n); const row = [];
  for (const [lb, a, b] of CROSS) {
    let g = 0, t = 0;
    for (let m = a; m < b; m += ST) { s(m / 60, A); const [r, gg, bl] = f8(A.horizon); t++; if (gg < r && gg < bl) g++; }
    row.push(`${lb} ${(g * ST).toFixed(1)}/${(t * ST).toFixed(0)} min`);
  }
  console.log(`${n.padEnd(6)} ${row.join('    ')}`);
}

console.log('\n== 5. THE SUNSET, MINUTE BY MINUTE, 17:45-20:15 — max |d| vs HEAD ==');
for (const n of ['prev', 'warp', 'ship']) {
  let mx = 0, at = 0;
  for (let m = 17 * 60 + 45; m <= 20 * 60 + 15; m += ST) {
    sampleHEAD(m / 60, A); W.setSkyRule(n); W.sampleTOD(m / 60, B);
    const d = Math.max(dist(A.horizon, B.horizon), dist(A.fog, B.fog), dist(A.sky, B.sky));
    if (d > mx) { mx = d; at = m; }
  }
  console.log(`${n.padEnd(6)} max ${mx.toFixed(3)} codes @${hhmmss(at)}  (0.000 = arithmetically untouched)`);
}
