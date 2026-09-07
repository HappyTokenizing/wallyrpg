#!/usr/bin/env node
/* ============================================================
   _k27-ref.mjs — THE TRADE AGAINST A SUPERSAMPLED GROUND TRUTH.

   WHY THIS FILE EXISTS. edgeW (_j26-sharp, _k27-trade) is a SMEAR
   WIDTH, and antialiasing widens a smear. A raw aliased step is one
   pixel wide and scores beautifully on it while looking like a flight
   of stairs. So edgeW can rank the RESOLUTION axis honestly and cannot
   rank the MSAA axis at all — it moved the wrong way on every msaa row
   of _k27-trade, which is the metric failing, not MSAA winning.

   The measure that ranks both axes at once is the one every AA paper
   uses: distance from the image an unlimited budget would have drawn.
   The reference here is pixelRatio 4 with MSAA 4 in a 1600x900 CSS box
   — a 6400x3600 buffer, 4 fragments per output pixel, 4 samples each —
   composited down onto the same 3200x1800 surface every other row is
   captured on. RMSE against it penalises BLUR (too little resolution)
   and JAGGIES (too little AA) in the same number, which is exactly the
   trade being decided.

   THE WORLD MUST BE FROZEN OR THIS MEASURES THE WIND. Grass sways, an
   NPC walks, Wally breathes; a pixelwise difference between two
   captures taken twenty seconds apart is mostly that. So every
   subsystem's update/lateUpdate hook is nulled except the render
   module's, and main.js's draw() keeps drawing the same instant.

   AND THE FREEZE IS PROVEN, NOT ASSERTED: the first row is captured
   TWICE, and its self-RMSE is printed at the top. If that is not far
   below the smallest difference between two settings, nothing below it
   means anything and the run says so.

   THE BIAS, STATED. The reference goes through Chrome's own compositor
   downscale, which is not a perfect box filter, so the reference may
   carry a little blur of its own — which flatters BLURRIER candidates.
   That is the conservative direction for a resolution-favouring
   conclusion: if resolution still wins, it wins despite the bias.
   ============================================================ */
import { boot, sleep, load1, loadGate, ENVSTATE } from './_j26-lib.mjs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PLACE = arg('place', 'cafe');
const MAXLOAD = +arg('maxload', 4);
const KEEP = arg('keep', null);
const HOUR = arg('hour', '12.5');
const W = +arg('w', 1600), H = +arg('h', 900), DSF = +arg('dsf', 2);
const PHONE = process.argv.includes('--phone');
const REFPR = +arg('refpr', 4), REFMS = +arg('refms', 4);
/* THE OUTLINE CONTROL. The brief's question is whether MSAA at ratio 1
   does anything the inverted-hull outline pass has not already done:
   the hull draws a dark stroke along exactly the silhouettes MSAA
   smooths, so on outlined geometry MSAA may be antialiasing an edge
   that is already a deliberate band. Run this file twice, --nooutline
   and without; if MSAA's RMSE gain is much larger with the outline
   off, the outline was doing MSAA's job. The REFERENCE is captured in
   the same page state, so both sides of the comparison agree. */
const NOOUTLINE = process.argv.includes('--nooutline');

const COMBOS = (arg('combos', '1x0,1x2,1x4,1.25x0,1.25x2,1.5x0,1.5x2,1.5x4,2x0,2x2,2x4') || '')
  .split(',').map(s => s.split('x').map(Number));

const tmp = await mkdtemp(join(tmpdir(), 'k27ref-'));
if (KEEP) await mkdir(KEEP, { recursive: true });

const PY = String.raw`
import sys, json
import numpy as np
from PIL import Image

spec = json.load(open(sys.argv[1]))
ref = np.asarray(Image.open(spec['ref']).convert('RGB')).astype(np.float32)
regions = spec['regions']

def rmse(a, b):
    d = a - b
    return float(np.sqrt((d*d).mean()))

def psnr(a, b):
    m = ((a-b)**2).mean()
    return float('inf') if m <= 1e-12 else float(10*np.log10(255.0*255.0/m))

out = {}
for name, path in spec['rows']:
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    row = {}
    for rn, (x, y, w, h) in regions.items():
        A = a[y:y+h, x:x+w]; B = ref[y:y+h, x:x+w]
        row[rn] = dict(rmse=round(rmse(A, B), 3), psnr=round(psnr(A, B), 2))
    out[name] = row
print(json.dumps(out))
`;
await writeFile(join(tmp, 'r.py'), PY);

/* Null every subsystem hook but the renderer's. main.js runs
   _handles[i].update / .lateUpdate and then calls draw() separately,
   so the frame keeps being drawn while the world stops moving. */
const FREEZE = () => {
  const ctx = window.WALLY.ctx;
  const keep = ctx.render;
  let n = 0;
  for (const h of ctx._handles || []) {
    if (!h || h === keep) continue;
    for (const k of ['update', 'lateUpdate']) {
      if (typeof h[k] === 'function' && !h['__k27' + k]) { h['__k27' + k] = h[k]; h[k] = () => {}; n++; }
    }
  }
  return n;
};

const F = (s, n) => String(s).padEnd(n);
const R = (s, n) => String(s).padStart(n);

console.log('# _k27-ref — every corner of the MSAA/resolution trade scored against a supersampled ground truth.');
console.log('# rig: headless Chrome (channel chrome), real WebGL2 ANGLE Metal, Apple M1 Max (32-core GPU), 10 CPU cores, macOS 14.4.');
console.log(`# ${W}x${H} CSS @ deviceScaleFactor ${DSF}${PHONE ? ' (touch + mobile UA)' : ' (no touch)'}, ?skipIntro&hour=${HOUR}, arrive('${PLACE}'), governor OFF, world FROZEN.`);
console.log(`# reference: pixelRatio ${REFPR} + msaa ${REFMS} = ${W * REFPR}x${H * REFPR} buffer, composited to the same ${W * DSF}x${H * DSF} surface as every row.`);
console.log('# outline pass: ' + (NOOUTLINE ? 'OFF (setOutline scale 0) — the control for "what has the hull already done?"' : 'ON, as shipped'));
console.log('# RMSE is in 0-255 sRGB units over the region, LOWER IS CLOSER TO GROUND TRUTH. PSNR in dB, higher is closer.\n');

const l0 = await loadGate(MAXLOAD);
const logs = [];
const { page, close } = await boot({ w: W, h: H, phone: PHONE, dpr: DSF, logs, qs: `?skipIntro&hour=${HOUR}` });
await sleep(5000);
const arrived = await page.evaluate((p) => { try { return WALLY.debug.arrive(p, true) === true; } catch (e) { return false; } }, PLACE);
await sleep(6000);
await page.evaluate(() => WALLY.debug.governor(false));
const env = await page.evaluate(ENVSTATE);
/* THE ORDER HERE IS LOAD-BEARING AND IT WAS WRONG ONCE. toon.js writes
   uOutlineScale from its OWN update(), so the hull must be turned off
   and then LEFT TO RENDER A FEW FRAMES before the freeze nulls that
   update — otherwise setOutline reports scale 0, the shader goes on
   reading 1, and the control measures nothing while looking exactly
   like a null result (it did: 0.180 vs 0.179 RMSE, indistinguishable
   from the outline-on run). tools/_k27-olcheck.mjs is the proof, and
   it prints the live uniform, not the setter's return value. */
if (NOOUTLINE) {
  await page.evaluate(() => { try { WALLY.debug.outline({ scale: 0 }); } catch (e) {} });
  await sleep(1000);
  const seen = await page.evaluate(() => { let v = null; WALLY.ctx.scene.traverse(o => { if (v == null && o.material?.uniforms?.uOutlineScale) v = o.material.uniforms.uOutlineScale.value; }); return v; });
  console.log(`    outline control: uOutlineScale in a live material = ${seen}  ${seen === 0 ? '(OFF — control fired)' : '(STILL ON — THIS RUN MEASURES NOTHING)'}`);
}
const frozen = await page.evaluate(FREEZE);
await sleep(1200);

console.log(`    tier '${env.tier}'  tier msaa ${env.msaa}  devicePixelRatio ${env.dpr}  arrive('${PLACE}') ${arrived ? 'TRUE' : 'FALSE — boot position'}   hooks nulled: ${frozen}`);

/* Regions in SURFACE pixels. `all` is the whole frame minus the HUD
   strip; the others are the places the art argument actually lives. */
const S = (x, y, w, h) => [Math.round(x * DSF), Math.round(y * DSF), Math.round(w * DSF), Math.round(h * DSF)];
const regions = {
  frame: S(0, 120, W, H - 180),
  detail: S(Math.round(W * 0.62), Math.round(H * 0.28), Math.round(W * 0.22), Math.round(H * 0.26)),
};
const cf = await page.evaluate(() => { try { return WALLY.debug.camFrame(); } catch (e) { return null; } });
if (cf && cf.wallyHeightPct > 3) {
  const cx = (cf.wallyXPct / 100) * W, top = (cf.wallyTopPct / 100) * H, bot = (cf.wallyFeetPct / 100) * H;
  const hgt = Math.max(24, bot - top), half = Math.max(24, hgt * 0.45);
  const x = Math.max(0, Math.round(cx - half)), y = Math.max(0, Math.round(top));
  regions.wally = S(x, y, Math.min(W - x, Math.round(half * 2)), Math.min(H - y, Math.round(hgt)));
}
console.log(`    regions (surface px): ${JSON.stringify(regions)}`);

async function shoot(pr, ms, tag) {
  const set = await page.evaluate(([p, m]) => {
    WALLY.debug.pixelRatio(p);
    const got = WALLY.debug.msaa(m);
    return { got, vp: WALLY.debug.viewport() };
  }, [pr, ms]);
  await sleep(2200);
  const p = join(tmp, `${tag}.png`);
  await page.screenshot({ path: p });
  return { path: p, set };
}

/* the reference first, then the rows, then the very first row again */
const ref = await shoot(REFPR, REFMS, 'ref');
const rows = [];
for (const [pr, ms] of COMBOS) rows.push({ pr, ms, ...(await shoot(pr, ms, `pr${String(pr).replace('.', '_')}_ms${ms}`)) });
const selfA = rows[0];
const selfB = await shoot(COMBOS[0][0], COMBOS[0][1], 'self');

const spec = {
  ref: ref.path, regions,
  rows: rows.map(r => [`${r.pr}x${r.ms}`, r.path]).concat([['SELF', selfB.path]]),
};
await writeFile(join(tmp, 'spec.json'), JSON.stringify(spec));
const res = JSON.parse(execSync(`python3 ${join(tmp, 'r.py')} ${join(tmp, 'spec.json')}`, { maxBuffer: 1 << 26 }).toString());

/* the freeze proof: same setting, two captures ~30 s apart */
await writeFile(join(tmp, 'self.json'), JSON.stringify({ ref: selfA.path, regions, rows: [['SELFDIFF', selfB.path]] }));
const selfRes = JSON.parse(execSync(`python3 ${join(tmp, 'r.py')} ${join(tmp, 'self.json')}`, { maxBuffer: 1 << 26 }).toString());
console.log(`\n    FREEZE PROOF — the first setting captured twice, ~30 s apart, differenced against ITSELF:`);
console.log(`      ${Object.entries(selfRes.SELFDIFF).map(([k, v]) => `${k} RMSE ${v.rmse}`).join('   ')}`);
console.log('      Every number below must be well above this or it is noise.\n');

console.log('    ' + F('pr', 7) + F('msaa', 6) + F('buffer', 12) + F('Mpx', 8) +
  Object.keys(regions).map(k => R(k + ' RMSE', 13) + R('psnr', 8)).join(''));
console.log('    ' + F(`REF ${REFPR}`, 7) + F(REFMS, 6) + F(`${ref.set.vp.buffer[0]}x${ref.set.vp.buffer[1]}`, 12) +
  F(((ref.set.vp.buffer[0] * ref.set.vp.buffer[1]) / 1e6).toFixed(3), 8) + '  (ground truth — zero by construction)');
for (const r of rows) {
  const m = res[`${r.pr}x${r.ms}`];
  console.log('    ' + F(r.pr, 7) + F(r.set.got.samples, 6) + F(`${r.set.vp.buffer[0]}x${r.set.vp.buffer[1]}`, 12) +
    F(((r.set.vp.buffer[0] * r.set.vp.buffer[1]) / 1e6).toFixed(3), 8) +
    Object.keys(regions).map(k => R(m[k].rmse, 13) + R(m[k].psnr, 8)).join(''));
}
const m0 = res.SELF;
console.log('    ' + F(COMBOS[0][0] + '*', 7) + F(COMBOS[0][1], 6) + F('(drift row)', 12) + F('', 8) +
  Object.keys(regions).map(k => R(m0[k].rmse, 13) + R(m0[k].psnr, 8)).join(''));

console.log(`\n    load before ${l0} -> after ${load1()};  page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}`);
if (KEEP) { execSync(`cp ${ref.path} ${join(KEEP, 'ref.png')}`); for (const r of rows) execSync(`cp ${r.path} ${join(KEEP, `pr${String(r.pr).replace('.', '_')}_ms${r.set.got.samples}.png`)}`); }
console.log(`# PNGs: ${KEEP || tmp}`);
await close();
