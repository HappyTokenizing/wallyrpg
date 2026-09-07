#!/usr/bin/env node
/* ============================================================
   _j23-dwell.mjs — HOW LONG THE SKY IS COLOURLESS, IN REAL SECONDS.

   WHY THIS METRIC AND NOT THE ONE THE BRIEFS KEPT USING.
   The twenty-second judge showed that "nothing worse than HEAD at any
   minute" cannot be met by construction: a crossing repair MOVES the
   pale moment, so a fixed-minute comparison always finds some minute
   where the repaired build is paler than HEAD's best. The quantity
   that is invariant to that move is the TIME SPENT below a chroma
   floor — a player cannot see which minute the grey lands on, only
   how long they are looking at grey.

   So: walk all 1440 in-game minutes at a fine step, count the samples
   whose HORIZON chroma is under the floor, and convert to REAL
   seconds using the game's own clock (half an in-game minute per real
   second, so 1 in-game minute = 2 real seconds; a full day is 2880
   real seconds). Report the contiguous runs, which is what "per
   crossing" means — the runs are the crossings.

   Chroma is (max-min)/max on the GAMMA-SPACE 8-bit triple, the same
   definition tools/_sky-minute.mjs --analytic uses, so the numbers in
   the two rigs are comparable.

   HEAD IS A REAL HEAD CHECKOUT, not a rule on the switch. `git show
   HEAD:src/world/lighting.js` is written beside the real one so its
   relative imports resolve, imported, and deleted in a finally block.
   HEAD exports no setSkyDrain and its table has no weather term, so
   its dwell is one number for all four states, and this rig says so
   rather than printing the same row four times as if it had measured
   them.

   usage:
     node tools/_j23-dwell.mjs --floor 0.10 --rules ship5,ship --weather clear,cloudy,rain,storm
     node tools/_j23-dwell.mjs --floor 0.10 --head
   ============================================================ */

import { writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; };
const has = (n) => process.argv.includes(`--${n}`);

const FLOOR = +arg('floor', 0.10);
const ST = +arg('step', 0.01);          /* in-game minutes per sample */
const SECS_PER_MIN = 2;                  /* the game clock: 0.5 in-game min per real s */
const RULES = arg('rules', 'ship5,ship').split(',').filter(Boolean);
const WX = arg('weather', 'clear,cloudy,rain,storm').split(',').filter(Boolean);

const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
const g8 = (v) => 255 * Math.pow(Math.max(v, 0), 0.45455);
const chromaOf = (c) => { const r = g8(c.r), g = g8(c.g), b = g8(c.b); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx > 1e-4 ? (mx - mn) / mx : 0; };

const THREE = await import('../vendor/three.module.js');
const mk = () => ({ sun: new THREE.Color(), amb: new THREE.Color(), sky: new THREE.Color(), horizon: new THREE.Color(), fog: new THREE.Color(), sunEl: 0, exposure: 0 });
const A = mk();

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const { WEATHER } = await import('../src/world/weather.js');
const drainOf = (n) => {
  const w = WEATHER[n];
  if (!w) { console.error(`unknown weather ${n} — weather.js authors ${Object.keys(WEATHER).join(', ')}`); process.exit(2); }
  return Math.min(1, Math.max(0, (ss(0.34, 1.0, w.cloud) * 0.42 + w.storm * 0.34 - 0.03) / 0.45));
};

/** walk the day, return the contiguous below-floor runs */
function sweep(sample) {
  const runs = [];
  let cur = null, n = 0;
  const N = Math.round(1440 / ST);
  for (let i = 0; i < N; i++) {
    const m = i * ST;
    const ch = sample(m);
    if (ch < FLOOR) {
      n++;
      if (!cur) cur = { from: m, to: m, minCh: ch, minAt: m, samples: 0 };
      cur.to = m; cur.samples++;
      if (ch < cur.minCh) { cur.minCh = ch; cur.minAt = m; }
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return { runs, realSec: n * ST * SECS_PER_MIN };
}

const rows = [];

if (has('head')) {
  const tmp = join(ROOT, 'src/world/_j23_head_lighting.js');
  try {
    await writeFile(tmp, execFileSync('git', ['show', 'HEAD:src/world/lighting.js'], { cwd: ROOT, maxBuffer: 1 << 26 }));
    const H = await import('./../src/world/_j23_head_lighting.js');
    if (typeof H.setSkyDrain === 'function') console.log('# NOTE: HEAD exports setSkyDrain — the weather-blind claim below is WRONG, re-check');
    const r = sweep((m) => { H.sampleTOD(m / 60, A); return chromaOf(A.horizon); });
    rows.push({ rule: 'HEAD (real checkout)', wx: 'all four (HEAD has no weather term in the table)', ...r });
  } finally { await rm(tmp, { force: true }); }
} else {
  const L = await import('../src/world/lighting.js');
  for (const rule of RULES) {
    const got = L.setSkyRule(rule);
    if (got !== rule) { console.error(`lighting.js has no rule "${rule}" — it authors ${L.skyRuleNames().join(', ')}`); process.exit(2); }
    for (const wx of WX) {
      const dr = drainOf(wx);
      const r = sweep((m) => { L.setSkyDrain(dr); L.sampleTOD(m / 60, A); return chromaOf(A.horizon); });
      rows.push({ rule, wx: `${wx} (drain ${dr.toFixed(2)})`, ...r });
    }
  }
  L.setSkyDrain(0);
}

console.log(`rig: node ${process.version}, CPU only, sampleTOD off src/world/lighting.js as checked out.`);
console.log(`DWELL = real seconds per in-game day with HORIZON chroma < ${FLOOR.toFixed(2)}.`);
console.log(`step ${ST} in-game min (${(ST * SECS_PER_MIN).toFixed(2)} real s per sample); a whole day is 2880 real s.\n`);
for (const r of rows) {
  console.log(`${r.rule}   ${r.wx}`);
  console.log(`   DWELL ${r.realSec.toFixed(1)} real s/day   in ${r.runs.length} run(s)`);
  for (const q of r.runs) {
    console.log(`     ${hhmm(q.from)}–${hhmm(q.to)}   ${(q.samples * ST * SECS_PER_MIN).toFixed(1)} real s   min chroma ${q.minCh.toFixed(3)} @ ${hhmm(q.minAt)}`);
  }
  console.log('');
}
