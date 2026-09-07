#!/usr/bin/env node
/* _k27-olcheck — DID THE OUTLINE CONTROL ACTUALLY DO ANYTHING?
   _k27-ref --nooutline returned MSAA gains identical to the outline-on
   run (0.180 vs 0.179 RMSE). That is either a real null result — the
   hull and MSAA are not doing the same job — or a switch that never
   fired, and those two look exactly alike from the outside. So: one
   page load, world frozen, capture with the hull on and off, and print
   both the uniform the shader reads and the RMSE between the two
   images. A control that cannot be shown to change the frame is not a
   control. */
import { boot, sleep, load1 } from './_j26-lib.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const tmp = await mkdtemp(join(tmpdir(), 'k27ol-'));
const PY = String.raw`
import sys, json, numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
b = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.float32)
d = a - b
print(json.dumps(dict(rmse=round(float(np.sqrt((d*d).mean())), 4),
                      maxdiff=float(np.abs(d).max()),
                      pctChanged=round(float((np.abs(d).max(axis=2) > 6).mean()*100), 3))))
`;
await writeFile(join(tmp, 'd.py'), PY);

const logs = [];
console.log(`# load before: ${load1()}`);
const { page, close } = await boot({ w: 1600, h: 900, phone: false, dpr: 2, logs, qs: '?skipIntro&hour=12.5' });
await sleep(5000);
await page.evaluate(() => { try { WALLY.debug.arrive('cafe', true); } catch (e) {} });
await sleep(6000);
await page.evaluate(() => WALLY.debug.governor(false));
await page.evaluate(() => WALLY.debug.pixelRatio(1));
const FREEZE = () => {
  const ctx = window.WALLY.ctx, keep = ctx.render;
  let n = 0;
  for (const h of ctx._handles || []) { if (!h || h === keep) continue;
    for (const k of ['update', 'lateUpdate']) if (typeof h[k] === 'function' && !h['__k27' + k]) { h['__k27' + k] = h[k]; h[k] = () => {}; n++; } }
  return n;
};

/* set the outline BEFORE the freeze, because toon.js writes
   uOutlineScale from its own update() and a frozen module writes
   nothing — which is exactly how a control silently does nothing */
const read = () => ({ scale: WALLY.ctx.mat?.setOutline ? WALLY.ctx.mat.setOutline({}) : null });
for (const on of [true, false]) {
  /* set it, LET A FEW FRAMES RUN so toon.js's update() writes the
     uniform, THEN freeze. That ordering is the whole finding: with the
     freeze first, setOutline reports scale 0 and the shader keeps
     reading 1, and the control silently measures nothing. */
  await page.evaluate(() => { const c = WALLY.ctx; for (const h of c._handles || []) for (const k of ['update','lateUpdate']) if (h && h['__k27'+k]) { h[k] = h['__k27'+k]; delete h['__k27'+k]; } });
  const st = await page.evaluate((o) => WALLY.debug.outline({ scale: o ? 1 : 0 }), on);
  await sleep(600);
  const uni = await page.evaluate(() => {
    let v = null;
    WALLY.ctx.scene.traverse(o => { if (v == null && o.material && o.material.uniforms && o.material.uniforms.uOutlineScale) v = o.material.uniforms.uOutlineScale.value; });
    return v;
  });
  console.log(`outline(${on ? 1 : 0}) -> setOutline reports ${JSON.stringify(st)}   uOutlineScale seen in a live material: ${uni}`);
  await page.evaluate(FREEZE); await sleep(800);
  await page.screenshot({ path: join(tmp, on ? 'on.png' : 'off.png') });
  await sleep(400);
}
console.log('on vs off:', execSync(`python3 ${join(tmp, 'd.py')} ${join(tmp, 'on.png')} ${join(tmp, 'off.png')}`).toString().trim());
console.log(`# PNGs: ${tmp}   errors ${logs.filter(l => /PAGEERROR/.test(l)).length}   load after ${load1()}`);
await close();
