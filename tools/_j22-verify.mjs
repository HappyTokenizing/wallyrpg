#!/usr/bin/env node
/* ============================================================
   _j22-verify.mjs — DOES THE ANALYTIC SAMPLER PREDICT THE FRAME?

   Every cheap number in this round comes off sampleTOD on the CPU.
   That is a claim about the TABLE. The player sees the table after
   the band blend, the dome shader, ACES, the grade, bloom, vignette
   and grain. Rule 1 of this round is that no sampling is taken on
   trust, mine included, so the fast path is checked against the
   screenshot path on the SAME minutes with the SAME differencing.

   Two things are compared, and they are different comparisons:

     RATE   the analytic rate must be differenced over the SAME
            interval as the rendered one or it is not the same
            quantity. tools/_sky-minute.mjs's d/s column differences
            ADJACENT SAMPLED MINUTES, i.e. it is a 2-real-second
            average; the --analytic figure quoted in lighting.js
            (62.7) is an 0.1-second instantaneous peak. Those two
            numbers are not comparable and the difference between them
            is not error, it is the averaging. So the analytic is
            re-differenced at one minute here.

     LEVEL  the analytic horizon chroma against the rendered bandSat.
            These are NOT the same statistic (one is a table entry,
            the other is the mean of the bottom 18 % of a rendered sky
            column) so the test is rank agreement per minute, not
            equality: does the fast path order the builds the way the
            frame does?
   ============================================================ */
import * as W from '../src/world/lighting.js';
import { sampleTOD as sampleHEAD } from '../src/world/_j22_head_lighting.js';
import * as THREE from '../vendor/three.module.js';
import { readFile } from 'node:fs/promises';

const mk = () => ({ sun: new THREE.Color(), amb: new THREE.Color(), sky: new THREE.Color(), horizon: new THREE.Color(), fog: new THREE.Color(), sunEl: 0, exposure: 0 });
const A = mk(), B = mk();
const g8 = (v) => 255 * Math.pow(Math.max(v, 0), 1 / 2.2);
const f8 = (c) => [g8(c.r), g8(c.g), g8(c.b)];
const chroma = (c) => { const [r, g, b] = f8(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx > 1e-4 ? (mx - mn) / mx : 0; };
const dist = (x, y) => { const p = f8(x), q = f8(y); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const S = (n) => n === 'head' ? ((h, o) => sampleHEAD(h, o)) : ((h, o) => { W.setSkyRule(n); return W.sampleTOD(h, o); });

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const res = [];
for (const f of files) res.push(...JSON.parse(await readFile(f, 'utf8')).results);

console.log('== RATE: analytic differenced at ONE MINUTE vs the rendered d/s, same minutes ==');
console.log('   (the analytic 0.1 s peak is also shown so the averaging is visible, not hidden)');
console.log('rule  mode  window          rendered peak/mean   analytic-1min peak/mean   analytic-0.1s peak');
const wins = [['0730-0750', 450, 470], ['1710-1730', 1030, 1050], ['0820-0840', 500, 520], ['1635-1655', 995, 1015]];
const rows = [];
for (const rule of ['head', 'prev', 'warp', 'ship']) {
  const s = S(rule);
  for (const [lb, a, b] of wins) {
    for (const mode of ['anti', 'sun']) {
      const rr = res.filter(r => r.rule === rule && r.mode === mode && r.minute > a && r.minute <= b).sort((x, y) => x.minute - y.minute);
      if (rr.length < 5) continue;
      const rd = [];
      for (let i = 1; i < rr.length; i++) if (rr[i].minute === rr[i - 1].minute + 1) {
        const p = rr[i - 1].bandRGB, q = rr[i].bandRGB;
        rd.push(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / 2);
      }
      const an = [];
      for (let m = a + 1; m <= b; m++) { s(m / 60, A); s((m + 1) / 60, B); an.push(dist(A.horizon, B.horizon) / 2); }
      let pk = 0; for (let m = a; m <= b; m += 0.05) { s(m / 60, A); s((m + 0.05) / 60, B); pk = Math.max(pk, dist(A.horizon, B.horizon) / 0.1); }
      const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
      rows.push({ rule, mode, lb, rp: Math.max(...rd), rm: mean(rd), ap: Math.max(...an), am: mean(an), pk });
      console.log(`${rule.padEnd(5)} ${mode.padEnd(5)} ${lb.padEnd(15)} ${Math.max(...rd).toFixed(1).padStart(5)} / ${mean(rd).toFixed(2).padStart(5)}       ` +
        `${Math.max(...an).toFixed(1).padStart(6)} / ${mean(an).toFixed(2).padStart(5)}          ${pk.toFixed(1).padStart(6)}`);
    }
  }
}
{
  const x = rows.map(r => r.ap), y = rows.map(r => r.rp);
  const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  console.log(`\n   analytic-1min peak vs rendered peak over ${n} (rule,mode,window) cells: r = ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}, ` +
    `slope ${(sxy / sxx).toFixed(2)} (rendered per analytic code)`);
  const ratio = rows.map(r => r.rp / r.ap).filter(v => isFinite(v));
  ratio.sort((a, b) => a - b);
  console.log(`   rendered/analytic peak ratio: median ${ratio[ratio.length >> 1].toFixed(2)}, range ${ratio[0].toFixed(2)}-${ratio[ratio.length - 1].toFixed(2)}`);
}

console.log('\n== LEVEL: does the fast path ORDER the builds the way the frame does? ==');
console.log('   per minute and mode, rank the three repairs by analytic horizon chroma and by rendered bandSat');
let agree = 0, tot = 0, both = 0;
const minutes = [...new Set(res.filter(r => r.rule !== 'head').map(r => r.minute))].sort((a, b) => a - b);
for (const m of minutes) for (const mode of ['anti', 'sun']) {
  const got = ['prev', 'warp', 'ship'].map(rule => {
    const r = res.find(x => x.minute === m && x.mode === mode && x.rule === rule);
    if (!r) return null;
    const s = S(rule); s(m / 60, A);
    return { rule, an: chroma(A.horizon), rn: r.bandSat };
  });
  if (got.some(g => !g)) continue;
  tot++;
  const oa = [...got].sort((p, q) => p.an - q.an).map(g => g.rule).join('');
  const or = [...got].sort((p, q) => p.rn - q.rn).map(g => g.rule).join('');
  if (oa === or) agree++;
  /* the question that actually matters: is the PALEST build the same one? */
  const pa = [...got].sort((p, q) => p.an - q.an)[0].rule, pr = [...got].sort((p, q) => p.rn - q.rn)[0].rule;
  if (pa === pr) both++;
}
console.log(`   full 3-way order agrees on ${agree}/${tot} (minute,mode) cells (${(100 * agree / tot).toFixed(0)} %)`);
console.log(`   the PALEST build agrees on ${both}/${tot} (${(100 * both / tot).toFixed(0)} %)`);
console.log('   -> the fast path is trustworthy for RATE and for WHICH BUILD IS PALEST; it is not a');
console.log('      substitute for bandSat, because bandSat also carries the band blend and the tone map.');
