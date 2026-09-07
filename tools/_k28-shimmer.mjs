#!/usr/bin/env node
/* ============================================================
   _k28-shimmer.mjs — THE AXIS NEITHER SIDE OF THIS TRADE SAMPLED.

   edgeW (_j26-sharp, _k28-acuity) and RMSE-against-ground-truth
   (_k27-ref) are both STILL-FRAME measures, and _k27-ref goes further
   and FREEZES the world so that they can be taken at all. The decision
   between MSAA and resolution was made entirely on still frames.

   But the failure mode a bigger buffer actually risks is TEMPORAL: a
   thinner sample footprint means a thin feature — a grass blade, a
   railing, a window mullion — crosses in and out of its sample between
   frames and CRAWLS. This chain has no TAA (renderer.js §3: the chain
   ends in FXAA), so nothing in it damps that. And MSAA is the one
   thing in the trade that does suppress geometric crawl, because it
   keeps the coverage of a moving edge continuous. So "resolution beats
   MSAA per millisecond" is a claim proven on exactly the axis where
   MSAA is weakest and unproven on the one where it is strongest.

   THIS MEASURES THE FRAME-TO-FRAME ENERGY. World ALIVE, camera still,
   N captures ~250 ms apart per option, on ONE page load with the ratio
   and the samples live-switched, so wind, NPCs and water are the same
   process and the same clock in every row.

     tRMS   RMS of the frame-to-frame luma difference over the crop,
            in 8-bit levels. Higher = more motion energy delivered.
     tP99   99th percentile of |frame-to-frame difference| — the size
            of the worst-crawling pixel, which is what the eye lands on.
     tHF    share of the DIFFERENCE image's FFT power above 0.2 cyc/px.
            Real motion (a swaying blade) is low-frequency in the
            difference; aliasing crawl is high-frequency. This is the
            column that separates "more motion is visible" from "the
            motion has turned into sparkle".

   IT CANNOT SEPARATE the two entirely, and says so: a sharper buffer
   legitimately delivers more of the grass's real movement, so tRMS
   rising is expected and is not by itself a defect. tHF rising FASTER
   than tRMS is the tell.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PLACE = arg('place', 'mainstreet');
const MAXLOAD = +arg('maxload', 5);
const N = +arg('n', 6);
const ONLY = arg('only', null);

const tmp = await mkdtemp(join(tmpdir(), 'k28shim-'));

const PY = String.raw`
import sys, json
import numpy as np
from PIL import Image

def L(p, c):
    a = np.asarray(Image.open(p).convert('L')).astype(np.float32)
    x, y, w, h = c
    return a[y:y+h, x:x+w]

spec = json.load(open(sys.argv[1]))
out = {}
for name, paths, crop in spec:
    fr = [L(p, crop) for p in paths]
    rms, p99, hf = [], [], []
    for i in range(len(fr)-1):
        d = fr[i+1] - fr[i]
        rms.append(float(np.sqrt((d*d).mean())))
        p99.append(float(np.percentile(np.abs(d), 99)))
        n = min(512, d.shape[0], d.shape[1]); n -= n % 2
        c = d[:n, :n]
        win = np.outer(np.hanning(n), np.hanning(n))
        F = np.fft.fftshift(np.abs(np.fft.fft2((c - c.mean())*win)))**2
        yy, xx = np.mgrid[0:n, 0:n]
        r = np.sqrt((yy-n/2)**2 + (xx-n/2)**2)/(n/2)*0.5
        tot = F[r <= 0.5].sum()
        hf.append(float(F[(r > 0.2) & (r <= 0.5)].sum()/tot) if tot > 0 else float('nan'))
    med = lambda a: float(np.median(a))
    out[name] = dict(tRMS=round(med(rms), 4), tP99=round(med(p99), 3),
                     tHF=round(med(hf), 5), n=len(rms))
print(json.dumps(out))
`;
await writeFile(join(tmp, 's.py'), PY);

const VIEWPORTS = [
  { label: 'desktop 1600x900 @ dsf 2 (tier high)', w: 1600, h: 900, phone: false, dsf: 2,
    crop: { x: 380, y: 400, w: 500, h: 320 },
    combos: [[1, 4], [1, 0], [1.264, 2], [1.264, 0], [2, 2]] },
  { label: 'phone   390x844  @ dsf 3 (tier med)', w: 390, h: 844, phone: true, dsf: 3,
    crop: { x: 40, y: 330, w: 300, h: 260 },
    combos: [[1, 0], [2, 0], [2, 4]] },
];

const F = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);

console.log('# _k28-shimmer — frame-to-frame energy per option. World ALIVE, camera still, one page load per viewport.');
console.log('# rig: headless Chrome (channel chrome), WebGL2 ANGLE Metal, Apple M1 Max. No TAA anywhere in this chain.');
console.log(`# ${N} captures per row ~250 ms apart, ${N - 1} differences, median reported. Row * = first combo re-measured last.`);
console.log('# tRMS rising with the buffer is EXPECTED (more of the real motion is delivered). tHF rising FASTER is the crawl tell.\n');

for (const V of VIEWPORTS) {
  if (ONLY && !V.label.startsWith(ONLY)) continue;
  const l0 = await loadGate(MAXLOAD);
  const logs = [];
  const { page, close } = await boot({ w: V.w, h: V.h, phone: V.phone, dpr: V.dsf, logs, qs: '?skipIntro&hour=12.5' });
  await sleep(5000);
  const arrived = await page.evaluate((p) => { try { return WALLY.debug.arrive(p, true) === true; } catch (e) { return false; } }, PLACE);
  await sleep(6000);
  await page.evaluate(() => WALLY.debug.governor(false));
  const env = await page.evaluate(ENVSTATE);
  console.log(`=== ${V.label}   tier '${env.tier}'  arrive ${arrived ? 'TRUE' : 'FALSE — boot position'}   crop (CSS px) ${JSON.stringify(V.crop)}`);

  const plan = V.combos.concat([V.combos[0]]);
  const rows = [];
  for (let ci = 0; ci < plan.length; ci++) {
    const [pr, ms] = plan[ci];
    const set = await page.evaluate(([p, m]) => { WALLY.debug.pixelRatio(p); const got = WALLY.debug.msaa(m); return { got, vp: WALLY.debug.viewport() }; }, [pr, ms]);
    await sleep(2500);
    const shots = [];
    for (let i = 0; i < N; i++) {
      const p = join(tmp, `${V.w}_${ci}_${i}.png`);
      await page.screenshot({ path: p });
      shots.push(p);
      await sleep(250);
    }
    rows.push({ pr, ms, set, shots, drift: ci === plan.length - 1, key: `${ci}` });
  }
  const spec = rows.map(r => [r.key, r.shots,
    [Math.round(V.crop.x * V.dsf), Math.round(V.crop.y * V.dsf), Math.round(V.crop.w * V.dsf), Math.round(V.crop.h * V.dsf)]]);
  await writeFile(join(tmp, `spec${V.w}.json`), JSON.stringify(spec));
  const res = JSON.parse(execSync(`python3 ${join(tmp, 's.py')} ${join(tmp, `spec${V.w}.json`)}`, { maxBuffer: 1 << 26 }).toString());

  console.log('    ' + F('pr', 8) + F('msaa', 6) + F('buffer', 12) + F('Mpx', 8) + R('tRMS', 9) + R('tP99', 8) + R('tHF', 10) + R('tHF/tRMS', 11));
  const base = res['0'];
  for (const r of rows) {
    const m = res[r.key];
    console.log('    ' + F(r.pr + (r.drift ? '*' : ''), 8) + F(r.set.got.samples, 6) +
      F(`${r.set.vp.buffer[0]}x${r.set.vp.buffer[1]}`, 12) + F(((r.set.vp.buffer[0] * r.set.vp.buffer[1]) / 1e6).toFixed(3), 8) +
      R(m.tRMS, 9) + R(m.tP99, 8) + R(m.tHF, 10) + R((m.tHF / m.tRMS).toFixed(5), 11) +
      (r.key === '0' ? '' : `   vs first: tRMS x${(m.tRMS / base.tRMS).toFixed(2)}  tHF x${(m.tHF / base.tHF).toFixed(2)}`));
  }
  console.log(`    load before ${l0} -> after ${load1()};  page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}\n`);
  await close();
}
console.log(`# load (1-min) at end: ${load1()}`);
