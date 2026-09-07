#!/usr/bin/env node
/* ============================================================
   _fa-contend.mjs — IS THE DISAGREEMENT THE GAME OR THE BOX?

   Two agents measured 390x844 on this machine and got p50 7.0 and
   p50 21.5-31.4. _fa-settle.mjs already showed the _sm-lib probe is
   not the difference (phase B is sometimes FASTER than phase A) and
   that adjacent readings of the SAME scene wander 6.0 -> 12.1 ms while
   `uptime` load wanders 14 -> 23. So the hypothesis is contention.

   THIS IS THE SWITCH, and it is the strong form: the measured page is
   ONE page load, one scene, one camera, never reloaded. The only thing
   that changes is whether N OTHER headless Chromes are rendering the
   same game on the same GPU. On -> off -> on, so a monotone drift in
   the box cannot fake it.

   If the quiet readings land on the judge's number and the contended
   readings land on the fixer's, then neither agent measured wrong and
   neither measured the game: they measured the machine, at two
   different times, and the game's own number is the quiet one.
   ============================================================ */
import { boot, ROOT } from './_sm-lib.mjs';
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const W = +arg('w', 390), H = +arg('h', 844);
const REPS = +arg('reps', 5), SECS = +arg('secs', 4), NCONTEND = +arg('contenders', 2);
const load = () => execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0];

const logs = [];
const { page, port, close } = await boot({ w: W, h: H, logs, limiter: false });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);
await page.evaluate(() => WALLY.debug.arrive('markethall', true));
await page.waitForTimeout(3000);
const tier = await page.evaluate(() => WALLY.ctx.quality.name);
console.log(`# measured page: ${W}x${H} dpr1 tier ${tier}, market square, limiter OFF, ONE page load throughout`);

/* the judge's own method, so the comparison is to his definition */
const sample = () => page.evaluate(async (s) => {
  const t0 = performance.now(); const ms = []; let last = t0;
  while (performance.now() - t0 < s * 1000) {
    await new Promise(r => requestAnimationFrame(r));
    const n = performance.now(); ms.push(n - last); last = n;
  }
  ms.shift(); ms.shift();
  const v = ms.slice().sort((a, b) => a - b);
  const q = p => v[Math.min(v.length - 1, Math.max(0, Math.ceil(v.length * p) - 1))];
  const c = WALLY.debug.perf();
  return { n: v.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), worst: +v[v.length - 1].toFixed(2),
    cp50: c.p50, cp95: c.p95, cpu: c.cpuMs };
}, SECS);

async function block(tag) {
  const out = [];
  for (let i = 0; i < REPS; i++) {
    const r = await sample();
    out.push(r.p50);
    console.log(`  ${tag.padEnd(22)} #${i + 1}  judge-rAF p50 ${String(r.p50).padStart(6)} p95 ${String(r.p95).padStart(6)} worst ${String(r.worst).padStart(6)} | census p50 ${String(r.cp50).padStart(6)} cpu ${String(r.cpu).padStart(5)} | load ${load()}`);
  }
  const v = out.slice().sort((a, b) => a - b);
  console.log(`  ${tag.padEnd(22)} => p50 across reps: min ${v[0]}  med ${v[v.length >> 1]}  max ${v[v.length - 1]}\n`);
  return v;
}

let contenders = [];
async function startContenders(n) {
  for (let i = 0; i < n; i++) {
    const b = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization', '--hide-scrollbars', '--mute-audio', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
    const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
    await p.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
    await p.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
    contenders.push(b);
  }
  await new Promise(r => setTimeout(r, 4000));
}
async function stopContenders() { for (const b of contenders) await b.close(); contenders = []; await new Promise(r => setTimeout(r, 6000)); }

const q1 = await block('1 QUIET');
await startContenders(NCONTEND);
console.log(`  [${NCONTEND} contending headless Chromes now rendering the same game at 1600x900 on the same GPU]`);
const c1 = await block('2 CONTENDED');
await stopContenders();
console.log('  [contenders closed]');
const q2 = await block('3 QUIET AGAIN');

const m = v => v[v.length >> 1];
console.log(`# VERDICT  quiet ${m(q1)} ms -> contended ${m(c1)} ms -> quiet again ${m(q2)} ms   (median of ${REPS} reps each, same page load)`);
console.log('# page errors:', logs.filter(l => /PAGEERROR/.test(l)).length);
await close();
