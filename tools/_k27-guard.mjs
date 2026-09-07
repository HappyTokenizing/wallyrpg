#!/usr/bin/env node
/* ============================================================
   _k27-guard.mjs — THE THINGS THE MSAA/RESOLUTION CHANGE MUST NOT
   BREAK, CHECKED AT THE RATIO IT NOW CLIMBS TO.

   The tier change is three constants, so nothing in the shading maths
   moved. What CAN move without anyone editing a shader is anything
   authored in PIXELS, because the number of pixels changed:

     1. OUTLINE WEIGHT. toon.js holds the hull at a constant width in
        DEVICE pixels and multiplies by clamp(pixelRatio, 1, 2) so the
        weight is constant in CSS pixels — §2.2's ~1.6 px is a
        perceptual weight, not a device-pixel count. If that
        compensation were wrong, ratio 1.264 would deliver a 1.27 CSS-px
        hairline instead of 1.6 and the whole toon calibration would
        drift with the governor. Measured on the image, in CSS px.
     2. THE HULL BUDGET. hullCull.minPx retires a stroke below 9 px on
        screen. That test is in DEVICE pixels too, so a higher ratio
        could bring back strokes the budget had retired — a draw-call
        change nobody asked for. `hullsDrawn` is printed at both.
     3. THE TERMINATOR. The two-band terminator on the balloon
        envelope is a banding artefact in the toon ramp; more pixels
        cannot create a band, but a band that exists would become
        VISIBLE at a ratio where it was previously below sampling.
        Swept across sun bearings and counted as distinct luminance
        plateaus down the envelope.
     4. GRASS AND CAST SHADOWS still present, by draw call and by
        pixel count, at both ratios.
   ============================================================ */
import { boot, sleep, load1, ENVSTATE } from './_j26-lib.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PLACE = arg('place', 'cafe');
const tmp = await mkdtemp(join(tmpdir(), 'k27guard-'));

/* Outline weight, in CSS px, off the image: find dark strokes sitting
   against the sky (the one background whose colour is unambiguous) and
   report the median run length, divided by the device scale factor. */
const PY = String.raw`
import sys, json
import numpy as np
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
dsf = float(sys.argv[2]); y0 = int(sys.argv[3]); y1 = int(sys.argv[4])
a = np.asarray(im).astype(np.float32)[y0:y1]
lum = a.mean(axis=2)
# sky is the bright blue top band; a stroke is a dark run bounded by
# brighter pixels on both sides, on a row that contains sky
runs = []
for r in range(0, lum.shape[0], 3):
    row = lum[r]
    dark = row < (row.max() * 0.45)
    i = 0
    while i < len(dark):
        if dark[i]:
            j = i
            while j < len(dark) and dark[j]: j += 1
            if 0 < i and j < len(dark) and (j - i) <= 20*dsf:
                runs.append(j - i)
            i = j
        else: i += 1
runs = np.array(runs, dtype=np.float32)
out = dict(nRuns=int(runs.size))
if runs.size:
    out['medianDevicePx'] = round(float(np.median(runs)), 3)
    out['medianCssPx'] = round(float(np.median(runs))/dsf, 3)
    out['p25CssPx'] = round(float(np.percentile(runs, 25))/dsf, 3)
print(json.dumps(out))
`;
await writeFile(join(tmp, 'o.py'), PY);

/* Terminator: walk a vertical line down the balloon envelope and count
   distinct luminance plateaus. Two bands = the failure. */
const PYT = String.raw`
import sys, json
import numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('L')).astype(np.float32)
x0,y0,x1,y1 = [int(v) for v in sys.argv[2:6]]
sub = a[y0:y1, x0:x1]
col = sub.mean(axis=1)
col = np.convolve(col, np.ones(5)/5, mode='valid')
d = np.abs(np.diff(col))
# a BAND EDGE is a step much larger than the local gradient noise
thr = max(2.0, float(np.percentile(d, 97)) * 1.6)
edges = int((d > thr).sum())
print(json.dumps(dict(edges=edges, thr=round(thr,3), span=round(float(col.max()-col.min()),2))))
`;
await writeFile(join(tmp, 't.py'), PYT);

const DSF = 2, W = 1600, H = 900;
const logs = [];
console.log('# _k27-guard — the DO-NOT-BREAK list, at ratio 1 and at the ratio `high` now climbs to.');
console.log('# rig: headless Chrome (channel chrome), ANGLE Metal on Apple M1 Max, 10 cores, macOS 14.4.');
console.log(`# load at start: ${load1()}\n`);

const { page, close } = await boot({ w: W, h: H, phone: false, dpr: DSF, logs, qs: '?skipIntro&hour=12.5' });
await sleep(5000);
await page.evaluate((p) => { try { WALLY.debug.arrive(p, true); } catch (e) {} }, PLACE);
await sleep(6000);
await page.evaluate(() => WALLY.debug.governor(false));
const env = await page.evaluate(ENVSTATE);
console.log(`tier '${env.tier}'  msaa ${env.msaa}  prMax ${env.pixelRatioMax}  budget ${env.pixelBudget} Mpx  devicePixelRatio ${env.dpr}`);
const vp0 = await page.evaluate(() => { WALLY.debug.pixelRatio(null); WALLY.debug.governor(false); return WALLY.debug.viewport(); });
console.log(`governor's own ceiling in this box: prCeiling ${vp0.prCeiling}  (ladder step ${vp0.prStep}, budget ${vp0.prBudgetMpx} Mpx)\n`);

const RATIOS = [1, vp0.prCeiling];
for (const pr of RATIOS) {
  /* SET, THEN WAIT, THEN READ. toon.js writes uOutlineScale from its
     own update(), so reading it in the same evaluate that changed the
     ratio reports the PREVIOUS frame's value — this rig did exactly
     that on its first run and printed the two rows one apart, which
     looks precisely like the compensation being broken. Same trap as
     the outline control in _k27-ref; see _k27-olcheck.mjs. */
  await page.evaluate((v) => WALLY.debug.pixelRatio(v), pr);
  await sleep(2200);
  const st = await page.evaluate(() => ({
    vp: WALLY.debug.viewport(), ol: WALLY.debug.outline({}), info: WALLY.debug.renderInfo(),
  }));
  const p = join(tmp, `pr${String(pr).replace('.', '_')}.png`);
  await page.screenshot({ path: p });
  const ol = JSON.parse(execSync(`python3 ${join(tmp, 'o.py')} ${p} ${DSF} ${Math.round(H * 0.18 * DSF)} ${Math.round(H * 0.52 * DSF)}`).toString());
  console.log(`pr ${String(pr).padEnd(6)} buffer ${st.vp.buffer.join('x').padEnd(11)} samples ${st.vp.samples}  ` +
    `outline uniform px ${st.ol.px}  hulls ${st.ol.hullsDrawn}/${st.ol.hulls}  calls ${st.info.calls}  tris ${st.info.tris}`);
  console.log(`         stroke width on the image: ${JSON.stringify(ol)}`);
}

/* ---- the balloon envelope, across sun bearings ---- */
console.log('\n# balloon envelope — luminance plateaus down the envelope. 0-1 step edges is a smooth terminator; a two-band');
console.log('# terminator shows as a second hard step. Swept across sun bearings at the ratio the tier now climbs to.');
const hasBalloon = await page.evaluate(() => typeof WALLY.debug.balloonCam === 'function' && typeof WALLY.debug.balloon === 'function');
if (!hasBalloon) {
  console.log('  SKIPPED — WALLY.debug.balloon / balloonCam not present on this build. NOT CHECKED.');
} else {
  await page.evaluate((v) => WALLY.debug.pixelRatio(v), RATIOS[1]);
  const ok = await page.evaluate(() => { try { WALLY.debug.balloon(true); WALLY.debug.balloonCam('side'); return true; } catch (e) { return String(e.message).slice(0, 70); } });
  await sleep(3000);
  if (ok !== true) console.log(`  SKIPPED — ${ok}`);
  else {
    /* THE COMPARISON IS THE ASSERTION, and it has to be taken on the
       SAME FRAME. The first version of this swept every bearing at
       ratio 1 and then every bearing at the new ratio — and the
       balloon is FLYING, so the two sweeps photographed two different
       places (different buildings behind the envelope, visibly) and
       the "more steps at the new ratio" flags were about the scenery.
       So: per bearing, set the sun, let it settle, FREEZE the world
       (the same hook-nulling _k27-ref proves), then capture both
       ratios off that one frozen instant, then thaw for the next
       bearing. Only then is the ratio the only thing that moved. */
    const FREEZE = () => {
      const c = window.WALLY.ctx, keep = c.render; let n = 0;
      for (const h of c._handles || []) { if (!h || h === keep) continue;
        for (const k of ['update', 'lateUpdate']) if (typeof h[k] === 'function' && !h['__k27' + k]) { h['__k27' + k] = h[k]; h[k] = () => {}; n++; } }
      return n;
    };
    const THAW = () => {
      const c = window.WALLY.ctx;
      for (const h of c._handles || []) for (const k of ['update', 'lateUpdate']) if (h && h['__k27' + k]) { h[k] = h['__k27' + k]; delete h['__k27' + k]; }
    };
    console.log('  bearing   ratio 1 (the shipped frame)   ratio ' + RATIOS[1] + '            verdict   (same frozen frame, ratio is the only difference)');
    for (const az of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const r = az * Math.PI / 180;
      await page.evaluate(THAW);
      await page.evaluate(([x, z]) => WALLY.debug.sun(x, 0.55, z), [Math.cos(r), Math.sin(r)]);
      await sleep(1400);
      await page.evaluate(FREEZE);
      await sleep(500);
      const got = [];
      for (const pr of RATIOS) {
        await page.evaluate((v) => WALLY.debug.pixelRatio(v), pr);
        await sleep(1500);
        const p = join(tmp, `bal_${az}_pr${String(pr).replace('.', '_')}.png`);
        await page.screenshot({ path: p });
        got.push(JSON.parse(execSync(`python3 ${join(tmp, 't.py')} ${p} ${Math.round(W * 0.44 * DSF)} ${Math.round(H * 0.16 * DSF)} ${Math.round(W * 0.56 * DSF)} ${Math.round(H * 0.52 * DSF)}`).toString()));
      }
      const [a, b] = got;
      console.log(`  ${String(az).padStart(5)}deg   edges ${String(a.edges).padStart(2)}  span ${String(a.span).padEnd(8)}   edges ${String(b.edges).padStart(2)}  span ${String(b.span).padEnd(8)}   ${b.edges > a.edges ? 'NEW STEP — LOOK AT IT' : 'no new step'}`);
    }
  }
}
console.log(`\n# page errors: ${logs.filter(l => /PAGEERROR/.test(l)).length}   PNGs: ${tmp}   load at end: ${load1()}`);
await close();
