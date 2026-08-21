/* creasemeasure.mjs — measure the arm/flank crease against the reference.
 *
 * Reports, per height f (crown-to-sole fraction), scanning inward from the
 * figure's left edge across the arm/flank junction:
 *
 *   floor   luminance at the bottom of the crease   (spec #A9A9A8 = luma 169)
 *   depth   1 - floor / min(flanking peaks)
 *   recov   mm for the flank side to climb back to lit clay (ref: 15-25 mm)
 *
 * Usage: node tools/creasemeasure.mjs [game.png]
 * With no argument it shoots a fresh cool-pose studio frame first.
 */
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const F_ROWS = [0.44, 0.50, 0.56, 0.62, 0.68];

let game = process.argv[2];
if (!game) {
  game = 'shots/_cm.png';
  execSync(
    `node tools/shot.mjs ${game} --wait 6000 ` +
    `--eval "WALLY.debug.studio('cool')" --w 900 --h 1300`,
    { cwd: ROOT, stdio: 'pipe' }
  );
}
const REF = 'ref/wally-ref-cool.png';
for (const f of [game, REF]) {
  if (!existsSync(resolve(ROOT, f))) { console.error('missing', f); process.exit(1); }
}
const uri = (f) => 'data:image/png;base64,' + readFileSync(resolve(ROOT, f)).toString('base64');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();

const out = await page.evaluate(async ([g, r, rows]) => {
  const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = s; });

  async function scan(src) {
    const img = await load(src);
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    const W = cv.width, H = cv.height;
    const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const bg = lum(0);

    // figure extent
    let top = H, bot = 0;
    for (let y = 0; y < H; y++) {
      let hit = false;
      for (let x = 0; x < W; x += 2) { if (Math.abs(lum((y * W + x) * 4) - bg) > 18) { hit = true; break; } }
      if (hit) { if (y < top) top = y; if (y > bot) bot = y; }
    }
    const figH = bot - top;
    const mm = 1600 / figH;                       // figure is 1.6 m tall

    const res = [];
    for (const f of rows) {
      const y = Math.round(top + figH * f);
      const row = [];
      for (let x = 0; x < W; x++) row.push(lum((y * W + x) * 4));
      let first = 0;
      for (let x = 0; x < W; x++) if (Math.abs(row[x] - bg) > 18) { first = x; break; }
      const seg = row.slice(first, first + 150);
      if (seg.length < 40) { res.push(null); continue; }

      let floor = 1e9, fi = 0;
      for (let k = 6; k < seg.length - 6; k++) if (seg[k] < floor) { floor = seg[k]; fi = k; }
      const leftPeak = Math.max(...seg.slice(0, Math.max(fi, 1)));
      const rightPeak = Math.max(...seg.slice(fi));
      const depth = 1 - floor / Math.min(leftPeak, rightPeak);

      // flank-side recovery: walking OUTWARD from the floor toward the body,
      // how far until luminance regains 90% of that side's peak
      let recov = -1;
      const target = leftPeak * 0.9;
      for (let k = fi; k >= 0; k--) if (seg[k] >= target) { recov = (fi - k) * mm; break; }

      res.push({
        f, floor: Math.round(floor), depth: +depth.toFixed(3),
        recovMm: recov < 0 ? null : Math.round(recov),
      });
    }
    return { figH, mmPerPx: +mm.toFixed(2), res };
  }
  return { game: await scan(g), ref: await scan(r) };
}, [uri(game), uri(REF), F_ROWS]);

await browser.close();

console.log(`\n  figure ${out.game.figH}px (${out.game.mmPerPx} mm/px)   spec deep crease #A9A9A8 = luma 169\n`);
console.log('   f      GAME floor  depth  recov | REF floor  depth  recov');
for (let i = 0; i < F_ROWS.length; i++) {
  const g = out.game.res[i], r = out.ref.res[i];
  if (!g || !r) { console.log(`  ${F_ROWS[i].toFixed(2)}   (no data)`); continue; }
  console.log(
    `  ${g.f.toFixed(2)}      ${String(g.floor).padStart(3)}     ${g.depth.toFixed(3)}  ${String(g.recovMm ?? '-').padStart(4)}mm |` +
    `   ${String(r.floor).padStart(3)}     ${r.depth.toFixed(3)}  ${String(r.recovMm ?? '-').padStart(4)}mm`
  );
}
const gm = out.game.res.filter(Boolean);
console.log(`\n  game floor range ${Math.min(...gm.map(x => x.floor))}-${Math.max(...gm.map(x => x.floor))}` +
            `   (too dark below ~110, too shallow above ~185)`);
