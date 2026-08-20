#!/usr/bin/env node
/* ============================================================
   ab.mjs — blind side-by-side comparison sheet.

   Takes two images, shuffles which one lands on the left, and
   composites them into a single labelled sheet (LEFT / RIGHT).
   The mapping is written to a sidecar JSON that the *orchestrator*
   reads — the judging agent only ever sees the sheet, so it cannot
   know which image is the new build and which is the reference.

   Usage:
     node tools/ab.mjs shots/a.png shots/b.png shots/sheet.png
     node tools/ab.mjs a.png b.png sheet.png --seed 7 --label "Wally, close"

   Writes:
     <sheet.png>        the composite the critic reads
     <sheet.png>.json   { left: <path>, right: <path>, seed }  <-- keep this away
                        from the critic

   The shuffle is seeded and deterministic so a run can be reproduced.
   ============================================================ */

import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';

const [, , aPath, bPath, outPath] = process.argv;
if (!aPath || !bPath || !outPath) {
  console.error('usage: node tools/ab.mjs <a.png> <b.png> <out.png> [--seed n] [--label text]');
  process.exit(1);
}
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const seed = +arg('seed', Math.floor(Date.now() / 1000) % 100000);
const label = arg('label', '');

/* Seeded coin flip — deterministic, and not correlated with argument order. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const flip = mulberry32(seed * 2654435761 >>> 0)() < 0.5;

const leftPath  = flip ? bPath : aPath;
const rightPath = flip ? aPath : bPath;

const toDataUri = async (p) =>
  'data:image/png;base64,' + (await readFile(resolve(p))).toString('base64');

const [leftURI, rightURI] = await Promise.all([toDataUri(leftPath), toDataUri(rightPath)]);

const html = `<!doctype html><meta charset=utf-8>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#101216;font:600 15px/1.2 -apple-system,system-ui,sans-serif;color:#e8e6e0}
  .sheet{display:flex;flex-direction:column;gap:0}
  .hdr{padding:12px 18px;letter-spacing:.16em;text-transform:uppercase;font-size:12px;
       color:#8b93a3;border-bottom:1px solid #23262e}
  .pair{display:flex;gap:2px;background:#23262e}
  .cell{flex:1;display:flex;flex-direction:column;background:#101216;min-width:0}
  .cap{padding:9px 0;text-align:center;letter-spacing:.3em;font-size:13px;
       color:#f0ede6;background:#181b21;border-bottom:1px solid #23262e}
  .cell img{width:100%;height:auto;display:block}
</style>
<div class="sheet">
  ${label ? `<div class="hdr">${label.replace(/[<>&]/g, '')}</div>` : ''}
  <div class="pair">
    <div class="cell"><div class="cap">LEFT</div><img src="${leftURI}"></div>
    <div class="cell"><div class="cap">RIGHT</div><img src="${rightURI}"></div>
  </div>
</div>`;

const browser = await chromium.launch({ channel: 'chrome', args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const page = await browser.newPage({ viewport: { width: 2200, height: 800 } });
await page.setContent(html, { waitUntil: 'load' });
const el = await page.$('.sheet');
await mkdir(dirname(resolve(outPath)), { recursive: true }).catch(() => {});
await el.screenshot({ path: resolve(outPath), animations: 'allow', timeout: 20000 });
await browser.close();

await writeFile(
  resolve(outPath) + '.json',
  JSON.stringify({ left: leftPath, right: rightPath, seed, label }, null, 2)
);

console.log(`wrote ${outPath}`);
console.log(`key   ${basename(outPath)}.json  (do NOT show this to the judge)`);
