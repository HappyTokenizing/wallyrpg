/* _perf-balloon.mjs — the named regression: the envelope must show NO
   two-band terminator at any sun bearing. Same framing, four bearings,
   one boot per msaa value, and the SAME statistic on both so the
   comparison is against the pre-change build rather than against a
   memory of it. */
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
const MSAA = process.argv.find(a => a.startsWith('--msaa='))?.slice(7) ?? '0';
const logs = [];
const { page, close } = await boot({ w: 1200, h: 800, qs: `?shot=1&msaa=${MSAA}`, logs });
await mkdir('shots/qp', { recursive: true }).catch(() => {});
await page.evaluate(() => { const d = window.WALLY.debug; d.arrive('cafe', true); d.arriveNow && d.arriveNow(); });
await page.waitForTimeout(1800);
const info = await page.evaluate(() => { window.WALLY.debug.setHour(12); window.WALLY.debug.balloon({ alt: 70 }); return 1; });
await page.waitForTimeout(2200);
const pos = await page.evaluate(() => { try { return window.WALLY.debug.balloonInfo(); } catch (e) { return { err: e.message }; } });
console.log('balloonInfo', JSON.stringify(pos).slice(0, 240));
const P = pos.at || pos.pos || [0, 70, 0];
for (const hour of [7.5, 10, 13, 16.5]) {
  await page.evaluate((h) => window.WALLY.debug.setHour(h), hour);
  /* PIN IT. The envelope sinks at ~1 m/s, so an unpinned balloon walks
     out of the framing between bearings and the four frames stop being
     the same picture. */
  await page.evaluate((p) => window.WALLY.debug.balloon({ at: p }), P);
  await page.evaluate((p) => window.WALLY.debug.lookAt(p[0], p[1] + 3, p[2], { dist: 15, az: 35, el: 4, fov: 40 }), P);
  await page.waitForTimeout(700);
  await page.evaluate((p) => window.WALLY.debug.balloon({ at: p }), P);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shots/qp/bal-m${MSAA}-h${hour}.png`, animations: 'allow' });
  console.log(`hour ${hour} -> shots/qp/bal-m${MSAA}-h${hour}.png`);
}
const errs = logs.filter(l => /PAGEERROR|\[error\]/.test(l));
if (errs.length) console.log('ERRORS ' + errs.slice(0, 4).join(' | '));
await close();
