#!/usr/bin/env node
/* ============================================================
   _k30-inv.mjs — THE CHECK _k27-guard.mjs PROMISES AND DOES NOT RUN.

   That file's header lists four invariants for the MSAA/resolution
   change. Three are implemented. The fourth —

     "4. GRASS AND CAST SHADOWS still present, by draw call and by
         pixel count, at both ratios."

   — appears nowhere in its 186 lines; 'grass' and 'shadow' occur only
   inside that comment. A declared assertion that does not exist is
   worse than a missing one, because the header reads like coverage.

   So: same frozen frame, one page load, ratio switched live, and both
   halves of the promise actually taken —
     BY DRAW CALL: the grass system's own visible meshes and triangles,
       and the shadow-casting set, read off the scene graph.
     BY PIXEL: a ground crop's high-frequency energy (grass blades are
       the highest spatial frequency in the game) and the fraction of
       it sitting in shadow, measured as pixels below a luminance
       threshold fitted to the lit/shadowed bimodality of the crop.
   Plus the shadow map's own size and cascade count, which is what a
   ratio change could plausibly disturb.
   ============================================================ */
import { boot, sleep, ENVSTATE, loadGate } from './_j26-lib.mjs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PLACE = arg('place', 'cafe');
const HOUR = arg('hour', '07.0');           // long shadows: the case a shadow check should be taken at
const tmp = await mkdtemp(join(tmpdir(), 'k30inv-'));

const PY = String.raw`
import sys, json
import numpy as np
from PIL import Image
spec = json.load(open(sys.argv[1]))
out = {}
for name, path, crop in spec:
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    x, y, w, h = crop
    c = a[y:y+h, x:x+w]
    lum = 0.2126*c[...,0] + 0.7152*c[...,1] + 0.0722*c[...,2]
    gx = np.abs(np.diff(lum, axis=1)); gy = np.abs(np.diff(lum, axis=0))
    # shadow: the crop is bimodal (lit grass / shadowed grass). Otsu on the
    # luminance histogram, then the darker mass's share.
    hist, edges = np.histogram(lum, bins=64, range=(0, 255))
    p = hist / max(hist.sum(), 1)
    om = np.cumsum(p); mu = np.cumsum(p * ((edges[:-1]+edges[1:])/2))
    mt = mu[-1]
    sb = (mt*om - mu)**2 / np.maximum(om*(1-om), 1e-12)
    k = int(np.argmax(sb)); thr = float((edges[k]+edges[k+1])/2)
    out[name] = dict(
        hf=round(float(np.percentile(gx, 99)), 3),
        lapmean=round(float(np.abs(4*lum[1:-1,1:-1]-lum[:-2,1:-1]-lum[2:,1:-1]-lum[1:-1,:-2]-lum[1:-1,2:]).mean()), 4),
        greenfrac=round(float((c[...,1] > c[...,0]).mean()), 4),
        shadowThr=round(thr, 1),
        shadowFrac=round(float((lum < thr).mean()), 4),
        lumMean=round(float(lum.mean()), 2), lumP5=round(float(np.percentile(lum, 5)), 2),
        size=[c.shape[1], c.shape[0]])
print(json.dumps(out))
`;
writeFileSync(join(tmp, 'm.py'), PY);

const l0 = await loadGate(6);
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, dpr: 2, logs, qs: `?skipIntro&hour=${HOUR}` });
await sleep(5000);
const arrived = await page.evaluate((p) => WALLY.debug.arrive(p, true), PLACE);
if (arrived !== true) { console.error(`FATAL: arrive('${PLACE}') = ${JSON.stringify(arrived)}`); await close(); process.exit(3); }
await sleep(7000);
await page.evaluate(() => {
  WALLY.debug.governor(false);
  WALLY.ctx.wally.root.visible = false;
  for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
});
await page.evaluate(() => WALLY.ctx.render.setGrain(0));
const env = await page.evaluate(ENVSTATE);
await sleep(1500);
/* freeze exactly as the crawl rig does */
const frozen = await page.evaluate(() => {
  const ctx = window.WALLY.ctx; let n = 0;
  for (const h of ctx._handles || []) {
    if (!h || h === ctx.render) continue;
    for (const k of ['update', 'lateUpdate']) if (typeof h[k] === 'function') { h[k] = () => {}; n++; }
  }
  return n;
});
await sleep(800);

console.log(`# _k30-inv — grass and cast shadows across the ratio change. rig: headless Chrome, ANGLE Metal, M1 Max, 1600x900 @ dsf 2.`);
console.log(`# ?skipIntro&hour=${HOUR} (the long-shadow hour), arrive('${PLACE}') TRUE, tier '${env.tier}', governor OFF, world FROZEN (${frozen} hooks), grain OFF, load ${l0}.`);

const rows = [];
for (const pr of [1, 1.264, 1]) {
  const set = await page.evaluate((p) => { WALLY.debug.pixelRatio(p); return WALLY.debug.viewport(); }, pr);
  await sleep(2000);
  const scene = await page.evaluate(() => {
    const ctx = WALLY.ctx;
    let grassMeshes = 0, grassTris = 0, casters = 0, receivers = 0, visMeshes = 0;
    ctx.scene.traverse(o => {
      if (!o.isMesh || !o.visible) return;
      visMeshes++;
      if (o.castShadow) casters++;
      if (o.receiveShadow) receivers++;
      const nm = ((o.name || '') + ' ' + (o.material?.name || '')).toLowerCase();
      const isGrass = /grass|blade/.test(nm) || !!o.material?.uniforms?.uGrassWind || !!o.userData?.grass;
      if (isGrass) {
        grassMeshes++;
        const g = o.geometry;
        const n = g?.index ? g.index.count / 3 : (g?.attributes?.position?.count || 0) / 3;
        grassTris += Math.round(n * (o.isInstancedMesh ? o.count : 1));
      }
    });
    const csm = ctx.render?.csm || ctx.csm;
    return { grassMeshes, grassTris, casters, receivers, visMeshes,
      calls: ctx.renderer.info.render.calls, tris: ctx.renderer.info.render.triangles,
      shadowMap: ctx.renderer.shadowMap.enabled,
      cascades: csm?.cfg?.cascades ?? null, shadowSize: csm?.cfg?.size ?? ctx.quality.shadowSize };
  });
  const path = join(tmp, `pr${String(pr).replace('.', '_')}_${rows.length}.png`);
  await page.screenshot({ path });
  rows.push({ pr, set, scene, path, drift: rows.length === 2 });
}

/* the ground crop: bottom-centre of the frame, which at this eye height
   is grass with the building's cast shadow falling across it */
const crop = [900, 1150, 1400, 550];
const spec = rows.map((r, i) => [`${r.pr}${r.drift ? '*' : ''}#${i}`, r.path, crop]);
writeFileSync(join(tmp, 'spec.json'), JSON.stringify(spec));
const px = JSON.parse(execSync(`python3 ${join(tmp, 'm.py')} ${join(tmp, 'spec.json')}`, { maxBuffer: 1 << 26 }).toString());

console.log(`\n  BY DRAW CALL (scene graph, same frozen frame)`);
console.log('  ' + 'pr'.padEnd(8) + 'buffer'.padEnd(12) + 'grass meshes'.padEnd(14) + 'grass tris'.padEnd(13) +
  'shadow casters'.padEnd(16) + 'receivers'.padEnd(11) + 'cascades'.padEnd(10) + 'map'.padEnd(7) + 'draw calls');
for (const r of rows) console.log('  ' + String(r.pr + (r.drift ? '*' : '')).padEnd(8) +
  `${r.set.buffer[0]}x${r.set.buffer[1]}`.padEnd(12) + String(r.scene.grassMeshes).padEnd(14) +
  String(r.scene.grassTris).padEnd(13) + String(r.scene.casters).padEnd(16) + String(r.scene.receivers).padEnd(11) +
  String(r.scene.cascades).padEnd(10) + String(r.scene.shadowSize).padEnd(7) + r.scene.calls);

console.log(`\n  BY PIXEL (ground crop ${crop.join(',')} surface px)`);
console.log('  ' + 'pr'.padEnd(8) + 'p99|dx| (blades)'.padEnd(18) + 'laplacian'.padEnd(12) + 'green frac'.padEnd(12) +
  'shadow thr'.padEnd(12) + 'shadow frac'.padEnd(13) + 'lum mean'.padEnd(10) + 'lum p5');
for (const [k, v] of Object.entries(px)) console.log('  ' + k.split('#')[0].padEnd(8) + String(v.hf).padEnd(18) +
  String(v.lapmean).padEnd(12) + String(v.greenfrac).padEnd(12) + String(v.shadowThr).padEnd(12) +
  String(v.shadowFrac).padEnd(13) + String(v.lumMean).padEnd(10) + v.lumP5);
console.log(`\n  * = first row re-measured last. page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}   PNGs ${tmp}`);
await close();
