#!/usr/bin/env node
/* ============================================================
   _j22-chroma.mjs — ROUND 6 JUDGE. CHROMA AND RATE AT ONE MINUTE,
   FOUR BUILDS, ON ONE PROCESS, DETERMINISTICALLY.

   WHY NOT tools/_sky-minute.mjs --analytic: that rig can only see the
   rules that live in the WORKING TREE's CROSS_RULES switch, and HEAD
   has no switch at all (HEAD's src/world/lighting.js is 801 lines and
   contains neither setSkyRule nor deMud nor crossFade). Its `lerp`
   rule is explicitly documented as NOT HEAD. So the fourth build is
   loaded here as a SECOND MODULE: src/world/_j22_head_lighting.js is a
   byte-identical copy of `git show HEAD:src/world/lighting.js`
   (sha256 02d3ac7f...), sitting in the same directory so its three
   relative imports resolve to the same palette/contracts/three the
   working tree uses. Both sampleTODs are then called in the same
   process, on the same clock, with no file swap to get backwards.

   contracts.js rule 1 in its strongest form: not a quotation, not a
   checkout, but yesterday's code and today's code side by side in one
   run, and every number below is a difference taken at the same
   minute.

   SAMPLING. 0.05 in-game minutes = 0.1 REAL seconds (the clock runs at
   half an in-game minute per real second), 28,800 samples per build
   per day. The crossing's colourless window is ~4 in-game minutes =
   8 real seconds wide; this resolves it 80 times over.

   chroma  = HSV saturation, (max-min)/max, of the gamma-encoded
             (2.2) 8-bit colour. Same definition tools/_sky-minute.mjs
             --analytic uses, so the numbers are comparable to every
             analytic figure quoted in src/world/lighting.js.
   rate    = |dRGB| between adjacent samples / 0.1 s, 8-bit sRGB codes
             per REAL second.

   usage: node tools/_j22-chroma.mjs [--json /tmp/x.json]
   ============================================================ */
import * as W from '../src/world/lighting.js';
import { sampleTOD as sampleHEAD } from '../src/world/_j22_head_lighting.js';
import * as THREE from '../vendor/three.module.js';

const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; };
const mk = () => ({ sun: new THREE.Color(), amb: new THREE.Color(), sky: new THREE.Color(),
  horizon: new THREE.Color(), fog: new THREE.Color(), sunEl: 0, exposure: 0 });
const A = mk(), B = mk();

const g8 = (v) => 255 * Math.pow(Math.max(v, 0), 1 / 2.2);
const f8 = (c) => [g8(c.r), g8(c.g), g8(c.b)];
const chroma = (c) => { const [r, g, b] = f8(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx > 1e-4 ? (mx - mn) / mx : 0; };
const val = (c) => Math.max(...f8(c)) / 255;
const hue = (c) => { const [r, g, b] = f8(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 1e-6) return -1; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return Math.round(((h * 60) % 360 + 360) % 360); };
const hex = (c) => '#' + f8(c).map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const gsmall = (c) => { const [r, g, b] = f8(c); return g < r && g < b; };
const dist = (x, y) => { const p = f8(x), q = f8(y); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;

/* the four builds. `head` is the second module; the rest drive the
   working tree's switch. `warp` is what SHIPPED (round 4) — the file
   renamed it when round 5 took the name `ship`, so the brief's "ship"
   is this entry and the brief's "the new one" is `ship`. */
const BUILDS = [
  ['head', (h, o) => sampleHEAD(h, o)],
  ['lerp', null], ['prev', null], ['warp', null], ['ship', null],
];
const sampler = (name) => {
  if (name === 'head') return (h, o) => sampleHEAD(h, o);
  return (h, o) => { W.setSkyRule(name); return W.sampleTOD(h, o); };
};

const ST = 0.05, SECS = ST * 2;            /* 0.05 in-game min = 0.1 real s */
const N = Math.round(1440 / ST);

/* ---- full-day scan: worst rate, pale minutes, per build ---- */
const day = {};
for (const [name] of BUILDS) {
  const S = sampler(name);
  let wh = { r: 0, m: 0 }, wf = { r: 0, m: 0 };
  let paleH = 0, paleF = 0, gsH = 0;
  const series = new Float64Array(N * 4);   /* chromaH, chromaF, rateH, rateF */
  for (let i = 0; i < N; i++) {
    const m = i * ST;
    S(m / 60, A); S((m + ST) / 60, B);
    const rh = dist(A.horizon, B.horizon) / SECS, rf = dist(A.fog, B.fog) / SECS;
    if (rh > wh.r) wh = { r: rh, m }; if (rf > wf.r) wf = { r: rf, m };
    series[i * 4] = chroma(A.horizon); series[i * 4 + 1] = chroma(A.fog);
    series[i * 4 + 2] = rh; series[i * 4 + 3] = rf;
  }
  for (let m = 0; m < 1440; m++) {
    S(m / 60, A);
    if (chroma(A.horizon) < 0.15) paleH++;
    if (chroma(A.fog) < 0.15) paleF++;
    if (gsmall(A.horizon)) gsH++;
  }
  day[name] = { worstH: wh, worstF: wf, paleH, paleF, gsH, series };
}

console.log('rig: node ' + process.version + ' CPU, one process, no renderer; ' +
  `${N} samples/build/day at ${ST} in-game min = ${SECS.toFixed(1)} real s`);
console.log('\n== WHOLE DAY ==');
console.log('build  worst-rate horizon      worst-rate fog        pale-min H  pale-min F  gSmall-min H');
for (const [name] of BUILDS) {
  const d = day[name];
  console.log(`${name.padEnd(6)} ${d.worstH.r.toFixed(1).padStart(6)} c/s @${hhmm(d.worstH.m)}      ` +
    `${d.worstF.r.toFixed(1).padStart(6)} c/s @${hhmm(d.worstF.m)}   ` +
    `${String(d.paleH).padStart(8)} ${String(d.paleF).padStart(11)} ${String(d.gsH).padStart(12)}`);
}

/* ---- the two crossings, minute by minute ---- */
const WINDOWS = [['MORNING', 7 * 60 + 15, 8 * 60 + 5], ['AFTERNOON', 16 * 60 + 50, 17 * 60 + 40]];
const table = {};
for (const [label, a, b] of WINDOWS) {
  console.log(`\n== ${label} CROSSING ${hhmm(a)}-${hhmm(b)} — horizon chroma / fog chroma ==`);
  console.log('time  ' + BUILDS.map(([n]) => (n + '      ').slice(0, 13)).join(''));
  const rows = [];
  for (let m = a; m <= b; m++) {
    const cells = [], rec = { time: hhmm(m), minute: m };
    for (const [name] of BUILDS) {
      const S = sampler(name);
      S(m / 60, A);
      const ch = chroma(A.horizon), cf = chroma(A.fog);
      rec[name] = { h: +ch.toFixed(3), f: +cf.toFixed(3), hex: hex(A.horizon), fhex: hex(A.fog), hue: hue(A.horizon), v: +val(A.horizon).toFixed(2) };
      cells.push(`${ch.toFixed(3)}/${cf.toFixed(3)}`.padEnd(13));
    }
    rows.push(rec);
    console.log(`${hhmm(m)} ${cells.join('')}`);
  }
  table[label] = rows;
}

/* ---- THE GATE THE BRIEF SETS: nothing worse than HEAD at any minute.
   Checked at the 0.1-real-second grid, not at the minute grid, over
   the whole day and over the crossings, on BOTH colours. ---- */
console.log('\n== "NOTHING WORSE THAN HEAD AT ANY MINUTE" — chroma, 0.1 real-s grid ==');
console.log('build  scope        worst deficit vs head   at        head    build   minutes below head');
const scopes = [['whole day', 0, 1440], ['morning', 7 * 60 + 15, 8 * 60 + 5], ['afternoon', 16 * 60 + 50, 17 * 60 + 40]];
const gate = {};
for (const [name] of BUILDS) {
  if (name === 'head') continue;
  gate[name] = {};
  for (const [sl, a, b] of scopes) {
    let worst = { d: 0, m: -1, hh: 0, bb: 0, which: '' }, below = 0, tot = 0;
    for (let m = a; m < b; m += ST) {
      sampleHEAD(m / 60, A); const hH = chroma(A.horizon), hF = chroma(A.fog);
      W.setSkyRule(name); W.sampleTOD(m / 60, B); const bH = chroma(B.horizon), bF = chroma(B.fog);
      tot++;
      const dH = hH - bH, dF = hF - bF;
      if (dH > worst.d) worst = { d: dH, m, hh: hH, bb: bH, which: 'horizon' };
      if (dF > worst.d) worst = { d: dF, m, hh: hF, bb: bF, which: 'fog' };
      if (dH > 1e-9 || dF > 1e-9) below++;
    }
    gate[name][sl] = { worst, below, tot };
    console.log(`${name.padEnd(6)} ${sl.padEnd(12)} ${worst.d.toFixed(3).padStart(6)} (${worst.which.padEnd(7)}) ` +
      `${worst.m >= 0 ? hhmm(worst.m) : '  -  '}   ${worst.hh.toFixed(3)}  ${worst.bb.toFixed(3)}  ` +
      `${(below * ST).toFixed(1)} of ${(tot * ST).toFixed(0)} in-game min`);
  }
}

/* ---- RATE through the crossings ---- */
console.log('\n== RATE through the crossings — sRGB codes per REAL second ==');
console.log('build  morning peakH  meanH   afternoon peakH  meanH   morning peakF  afternoon peakF');
const rate = {};
for (const [name] of BUILDS) {
  const S = sampler(name);
  const seg = (a, b) => {
    let pk = 0, sum = 0, n = 0, pkf = 0, at = 0;
    for (let m = a; m < b; m += ST) {
      S(m / 60, A); S((m + ST) / 60, B);
      const rh = dist(A.horizon, B.horizon) / SECS, rf = dist(A.fog, B.fog) / SECS;
      if (rh > pk) { pk = rh; at = m; } if (rf > pkf) pkf = rf;
      sum += rh; n++;
    }
    return { pk, at, mean: sum / n, pkf };
  };
  const mo = seg(7 * 60 + 15, 8 * 60 + 5), af = seg(16 * 60 + 50, 17 * 60 + 40);
  rate[name] = { mo, af };
  console.log(`${name.padEnd(6)} ${mo.pk.toFixed(1).padStart(9)} @${hhmm(mo.at)} ${mo.mean.toFixed(1).padStart(6)}  ` +
    `${af.pk.toFixed(1).padStart(12)} @${hhmm(af.at)} ${af.mean.toFixed(1).padStart(6)}  ` +
    `${mo.pkf.toFixed(1).padStart(11)} ${af.pkf.toFixed(1).padStart(16)}`);
}

/* ---- THE SUNSET AND THE INTRO MUST BE UNTOUCHED. Exact equality
   against HEAD, at the 0.1-real-second grid, on all five outputs
   sampleTOD writes. ---- */
console.log('\n== EXACTNESS vs HEAD (max |d| over 8-bit codes, 0.1 real-s grid) ==');
console.log('build  window                 sun    amb    sky    horizon  fog    sunEl   exposure');
const EXACT = [['sunset 18:00-20:00', 18 * 60, 20 * 60], ['intro 07:21 07:35', 7 * 60 + 21, 7 * 60 + 36],
  ['night 20:00-05:00', 20 * 60, 29 * 60], ['whole day', 0, 1440]];
const exact = {};
for (const [name] of BUILDS) {
  if (name === 'head') continue;
  exact[name] = {};
  for (const [lb, a, b] of EXACT) {
    let mx = { sun: 0, amb: 0, sky: 0, horizon: 0, fog: 0, sunEl: 0, exposure: 0 };
    for (let m = a; m < b; m += ST) {
      const hh = ((m / 60) % 24 + 24) % 24;
      sampleHEAD(hh, A); W.setSkyRule(name); W.sampleTOD(hh, B);
      for (const k of ['sun', 'amb', 'sky', 'horizon', 'fog']) mx[k] = Math.max(mx[k], dist(A[k], B[k]));
      mx.sunEl = Math.max(mx.sunEl, Math.abs(A.sunEl - B.sunEl));
      mx.exposure = Math.max(mx.exposure, Math.abs(A.exposure - B.exposure));
    }
    exact[name][lb] = mx;
    console.log(`${name.padEnd(6)} ${lb.padEnd(22)} ${mx.sun.toFixed(2).padStart(5)}  ${mx.amb.toFixed(2).padStart(5)}  ` +
      `${mx.sky.toFixed(2).padStart(5)}  ${mx.horizon.toFixed(2).padStart(7)}  ${mx.fog.toFixed(2).padStart(5)}  ` +
      `${mx.sunEl.toFixed(3).padStart(6)}  ${mx.exposure.toFixed(3).padStart(8)}`);
  }
}

const J = arg('json', null);
if (J) {
  const { writeFile } = await import('node:fs/promises');
  const strip = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { worstH: v.worstH, worstF: v.worstF, paleH: v.paleH, paleF: v.paleF, gsH: v.gsH }]));
  await writeFile(J, JSON.stringify({ day: strip(day), table, gate, rate, exact }, null, 1));
  console.log(`\njson -> ${J}`);
}
