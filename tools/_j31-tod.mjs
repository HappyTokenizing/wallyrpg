#!/usr/bin/env node
/* _j31-tod.mjs — JUDGE 31. IS sampleTOD ANALYTICALLY UNCHANGED IN A
   CLEAR SKY, AND IS THAT GUARANTEE LOAD-BEARING?

   lighting.js §"AND IT COSTS THE CLEAR SKY NOTHING BY CONSTRUCTION"
   claims round 6 (`ship`) and round 5 (`ship5`) agree BIT FOR BIT in
   clear weather, because WEATHER.clear.cloud (0.44) sits 0.004 under
   weatherDrain()'s deadband. Three things are checked here, on the CPU,
   no browser, no timing, so the box's load cannot touch the answer:

     A. weatherDrain(WEATHER.clear) is EXACTLY 0 — the tie between the
        two files the comment says rests on 0.004 of margin.
     B. ship vs ship5, every field of sampleTOD, compared as RAW IEEE
        BITS (not a tolerance) across 28 800 minute-samples of the day
        at drain 0. Object.is/tolerance would let a 1-ulp drift pass;
        the bit pattern will not.
     C. THE CONTROL THE COMMENT ITSELF NAMES: raise the authored cloud
        to 0.448 and the guarantee must BREAK. A proof that holds when
        the premise is false is not a proof. Plus the drain-1 sweep,
        which the comment says touches only 07:32-07:47 and 17:12-17:28. */
import { sampleTOD, setSkyRule, setSkyDrain, skyDrain, weatherDrain, skyRuleNames } from '../src/world/lighting.js';
import { WEATHER } from '../src/world/weather.js';
import * as THREE from '../vendor/three.module.js';

const mk = () => ({ sun: new THREE.Color(), amb: new THREE.Color(), sky: new THREE.Color(),
  horizon: new THREE.Color(), fog: new THREE.Color(), sunEl: 0, exposure: 0 });
const A = mk(), B = mk();
const buf = new ArrayBuffer(8), f64 = new Float64Array(buf), u32 = new Uint32Array(buf);
const bits = (x) => { f64[0] = x; return u32[0].toString(16).padStart(8, '0') + u32[1].toString(16).padStart(8, '0'); };
const FIELDS = ['sunEl', 'exposure'];
const COLS = ['sun', 'amb', 'sky', 'horizon', 'fog'];
const sig = (o) => FIELDS.map(f => bits(o[f])).join('|') + '|' +
  COLS.map(c => bits(o[c].r) + bits(o[c].g) + bits(o[c].b)).join('|');

const STEPS = +(process.argv[2] || 28800);   // minute-samples across the day
const sweep = () => {
  let diff = 0, first = null;
  /* CODES AND SCALARS ARE NOT THE SAME UNIT. The first cut of this
     file folded |dExposure|*255 into the same max as the colour
     channels and reported a 60.2-code worst case that was mostly
     exposure — a scalar multiplier, not an 8-bit code. They are
     separated now, because a judge publishing a discrepancy caused by
     its own metric is the fault it is here to catch. */
  let worstCode = 0, worstCodeAt = null, worstCh = null;
  let worstExp = 0, worstEl = 0;
  const moved = [];
  for (let i = 0; i < STEPS; i++) {
    const h = (i / STEPS) * 24;
    setSkyRule('ship5'); sampleTOD(h, A);
    setSkyRule('ship');  sampleTOD(h, B);
    if (sig(A) !== sig(B)) {
      diff++;
      if (first == null) first = h;
      for (const c of COLS) for (const ch of ['r', 'g', 'b']) {
        const d = Math.abs(A[c][ch] - B[c][ch]) * 255;
        if (d > worstCode) { worstCode = d; worstCodeAt = h; worstCh = c + '.' + ch; }
      }
      worstExp = Math.max(worstExp, Math.abs(A.exposure - B.exposure));
      worstEl = Math.max(worstEl, Math.abs(A.sunEl - B.sunEl));
      moved.push(h);
    }
  }
  return { diff, first, worstCode: +worstCode.toFixed(1), worstCodeAt, worstCh,
    worstExp: +worstExp.toFixed(4), worstEl: +worstEl.toFixed(4), moved };
};
const hhmm = (h) => h == null ? '-' : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const runs = (mm) => {           // contiguous minute-runs, for the drain-1 report
  const out = []; let s = null, p = null;
  for (const h of mm) { const m = Math.floor(h * 60); if (p == null || m > p + 1) { if (s != null) out.push([s, p]); s = m; } p = m; }
  if (s != null) out.push([s, p]);
  return out.map(([a, b]) => `${hhmm(a / 60)}-${hhmm(b / 60)}`);
};

console.log('# _j31-tod — CPU only, no browser, no timing. node ' + process.version + ', sampleTOD off src/world/lighting.js as checked out.');
console.log('# rules present in the module: ' + skyRuleNames().join(', '));
console.log('');

/* A */
const dClear = weatherDrain(WEATHER.clear);
console.log(`  A. weatherDrain(WEATHER.clear) = ${dClear}   (authored cloud ${WEATHER.clear.cloud}, storm ${WEATHER.clear.storm ?? 0})   ` +
  (Object.is(dClear, 0) ? 'EXACTLY 0 — pass' : '**NOT ZERO — the clear-sky guarantee is already void**'));

/* B */
setSkyDrain(0);
const clear = sweep();
console.log(`  B. drain ${skyDrain()} (clear): ship5 vs ship over ${STEPS} minute-samples x 7 fields, compared as raw IEEE754 bit patterns:`);
console.log(`     samples that differ in ANY bit: ${clear.diff}   ` +
  (clear.diff === 0 ? '-> BIT FOR BIT IDENTICAL. The claim holds.' : `-> first at ${hhmm(clear.first)}, worst ${clear.worstCode} codes on ${clear.worstCh} at ${hhmm(clear.worstCodeAt)}`));

/* C1: the deadband control */
const bumped = { ...WEATHER.clear, cloud: 0.448 };
const dBump = weatherDrain(bumped);
setSkyDrain(dBump);
const broken = sweep();
console.log(`  C1. CONTROL — authored cloud 0.44 -> 0.448: weatherDrain = ${dBump.toFixed(6)}, and the same sweep now differs at ` +
  `${broken.diff} samples (worst ${broken.worstCode} codes, max |dExposure| ${broken.worstExp}).   ` +
  (broken.diff > 0 ? 'The guarantee is LOAD-BEARING on that 0.004 of margin, exactly as the comment says.'
                   : '**the guarantee cannot be broken by its own stated premise — it is not testing what it claims**'));

/* C2: the drain-1 sweep the comment characterises */
setSkyDrain(1);
const full = sweep();
console.log(`  C2. drain 1 (storm, the most the rule can honour): ${full.diff} of ${STEPS} samples move.`);
console.log(`      worst COLOUR delta ${full.worstCode} codes on ${full.worstCh} at ${hhmm(full.worstCodeAt)};  max |dExposure| ${full.worstExp};  max |dSunEl| ${full.worstEl} deg.`);
console.log(`      minute-runs touched: ${runs(full.moved).join('  ') || '(none)'}`);
console.log(`      comment claims 07:32-07:47 (max 35.5 codes) and 17:12-17:28 (max 43.6) and nothing else.`);
setSkyDrain(0);
console.log(`\n# every number above is a pure function of the checked-out source; machine load cannot reach it. load now ${
  (await import('node:child_process')).execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0]}`);
