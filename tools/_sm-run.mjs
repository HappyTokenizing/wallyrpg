#!/usr/bin/env node
/* ============================================================
   _sm-run.mjs — the profile. Per-frame, per-scenario, published.

   node tools/_sm-run.mjs [--limiter] [--w 1600] [--h 900] [--out file.json]

   Scenarios (each a separate window on ONE page load, except MOBILE
   which needs its own viewport and so gets its own load):
     Q  quiet   — spawn, standing, streamer long finished
     B  busy    — market square, standing
     W  walking — W held, crossing chunk boundaries continuously
     F  first   — the 2 s after arriving in a district not yet visited
   ============================================================ */
import { writeFileSync } from 'node:fs';
import { boot, INJECT, stats, attribute } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);
const W = +arg('w', 1600), H = +arg('h', 900);
const LIMITER = flag('limiter');
const OUT = arg('out', '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/sm-profile.json');
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();

const logs = [];
const { page, close } = await boot({ w: W, h: H, logs, limiter: LIMITER });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);            // let the npc streamer finish
await page.evaluate(INJECT);

const meta = await page.evaluate(() => ({
  gpu: (() => { const gl = WALLY.ctx.renderer.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; })(),
  quality: WALLY.ctx.quality?.name, dpr: WALLY.ctx.renderer.getPixelRatio(), size: [innerWidth, innerHeight],
  places: Object.keys(WALLY.debug.places ? (WALLY.debug.places() || {}) : {}).slice(0, 40),
}));
console.log('# rig', JSON.stringify({ ...meta, viewport: [W, H], limiter: LIMITER, load: load() }));

const out = { meta: { ...meta, viewport: [W, H], limiter: LIMITER }, runs: [] };

async function run(label, secs, setup, during) {
  if (setup) { await page.evaluate(setup); }
  await page.waitForTimeout(label.startsWith('F') ? 60 : 2200);   // settle, except first-sight
  await page.evaluate((l) => window.__SMP__.start(l), label);
  const t0 = Date.now();
  if (during) await during(secs); else await page.waitForTimeout(secs * 1000);
  await page.evaluate(() => window.__SMP__.stop());
  const d = await page.evaluate(() => window.__SMP__.read());
  const census = await page.evaluate(() => WALLY.debug.perf());
  const rec = d.rec.slice(1);
  const gpu = rec.filter(r => r.gpu != null).map(r => r.gpu), cpu = rec.map(r => r.cpu);
  /* PRIMARY METRIC IS `wall`, NOT `raw`. See _sm-ts.mjs: with the
     frame-rate limiter off Chrome quantises the rAF TIMESTAMP to the
     vsync grid, so `raw` reports 0.7 ms frames that took 15 ms and a
     p95 of twice the median that is the grid, not the game. */
  const s = stats(rec.map(r => r.wall));
  const row = {
    label, load: load(), wallSec: +((Date.now() - t0) / 1000).toFixed(1),
    raw: s, rafTs: stats(rec.map(r => r.raw)), cpu: stats(cpu), gpu: stats(gpu),
    outside: stats(rec.map(r => +(r.wall - r.cpu).toFixed(3))),
    calls: rec[rec.length >> 1]?.calls, tris: rec[rec.length >> 1]?.tris,
    compiles: rec.reduce((a, r) => a + Math.max(0, r.dP), 0),
    geoUp: rec.reduce((a, r) => a + Math.max(0, r.dG), 0),
    texUp: rec.reduce((a, r) => a + Math.max(0, r.dT), 0),
    gcFrames: rec.filter(r => r.dH < -2).length,
    longTasks: d.long.length,
    attr: attribute(rec.map(r => ({ ...r, raw: r.wall })), s.p95),
    census: { p50: census.p50, p95: census.p95, worst: census.worst, n: census.n },
    worstFrames: rec.slice().sort((a, b) => b.wall - a.wall).slice(0, 6)
      .map(r => ({ wall: r.wall, raw: r.raw, cpu: r.cpu, gpu: r.gpu, dP: r.dP, dG: r.dG, dT: r.dT, dH: r.dH,
        top: Object.entries(r.c).sort((a, b) => b[1] - a[1]).slice(0, 5) })),
    rec,
  };
  out.runs.push(row);
  const p = (o) => o ? `p50 ${o.p50} p95 ${o.p95} p99 ${o.p99} worst ${o.worst}` : 'none';
  console.log(`\n== ${label}  n=${s.n} ${row.wallSec}s  load ${row.load}`);
  console.log(`   frame  ${p(s)}  mean ${s.mean}      (rAF ts: ${p(row.rafTs)})`);
  console.log(`   cpu    ${p(row.cpu)}`);
  console.log(`   gpu    ${p(row.gpu)}`);
  console.log(`   out    ${p(row.outside)}   (wall - cpu)`);
  console.log(`   calls ${row.calls} tris ${row.tris} compiles ${row.compiles} geo+${row.geoUp} tex+${row.texUp} gcFrames ${row.gcFrames} longTasks ${row.longTasks}`);
  console.log(`   census p50 ${census.p50} p95 ${census.p95} worst ${census.worst} n ${census.n}`);
  console.log(`   excess on the ${row.attr.nSlow} frames over ${row.attr.thr} ms:`);
  for (const [k, v, m] of row.attr.rows.slice(0, 8)) console.log(`      ${k.padEnd(14)} +${v} ms/slow-frame   (median ${m})`);
  console.log('   worst:', JSON.stringify(row.worstFrames.slice(0, 3)));
  return row;
}

const hold = async (secs) => {
  await page.keyboard.down('w');
  await page.waitForTimeout(secs * 1000);
  await page.keyboard.up('w');
};

await run('Q quiet (spawn, standing)', 8);
await run('B busy (market square, standing)', 8, () => { WALLY.debug.arrive('markethall', true); });
await run('W walking (W held, chunks crossing)', 10, () => { WALLY.debug.arrive('cafe', true); }, hold);
/* FIRST SIGHT: a district this page load has not been to. */
await run('F first sight (arrive, 2 s)', 2, () => { WALLY.debug.arrive('office', true); });
await run('F2 same district, second visit', 2, () => { WALLY.debug.arrive('markethall', true); });

writeFileSync(OUT, JSON.stringify(out));
console.log('\nwrote', OUT, 'errors:', logs.filter(l => /PAGEERROR/.test(l)).length);
await close();
